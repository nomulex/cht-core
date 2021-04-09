const _ = require('lodash');
const config = require('../config');
const transitionUtils = require('./utils');
const utils = require('../lib/utils');
const messages = require('../lib/messages');
const mutingUtils = require('../lib/muting_utils');
const contactTypesUtils = require('@medic/contact-types-utils');

const TRANSITION_NAME = 'muting';
const CONFIG_NAME = 'muting';
const MUTE_PROPERTY = 'mute_forms';
const UNMUTE_PROPERTY = 'unmute_forms';

const getConfig = () => {
  return config.get(CONFIG_NAME) || {};
};

const isMuteForm = form => {
  return Boolean(getConfig()[MUTE_PROPERTY].find(muteFormId => utils.isFormCodeSame(form, muteFormId)));
};

const isUnmuteForm = form => {
  const unmuteForms = getConfig()[UNMUTE_PROPERTY];
  return Boolean(unmuteForms && unmuteForms.find(unmuteFormId => utils.isFormCodeSame(form, unmuteFormId)));
};

const getEventType = muted => muted ? 'mute' : 'unmute';

const isContact = doc => !!contactTypesUtils.getContactType(config.getAll(), doc);

const isRelevantReport = (doc, info = {}) =>
  Boolean(doc &&
          doc.form &&
          doc.type === 'data_record' &&
          ( isMuteForm(doc.form) || isUnmuteForm(doc.form) ) &&
          !transitionUtils.hasRun(info, TRANSITION_NAME) &&
          utils.isValidSubmission(doc));

const isNewContactWithMutedParent = (doc, infoDoc = {}) => {
  return Boolean(
    !doc.muted &&
    // If initial_replication_date is 'unknown' .getTime() will return NaN, which is an
    // acceptable value to pass to isMutedInLineage (it will mean that it won't match because
    // there is no possible mute date that is "after" NaN)
    mutingUtils.isMutedInLineage(doc, new Date(infoDoc.initial_replication_date).getTime()) &&
    !infoDoc.muting_history
  );
};

const isMutedOffline = (doc) => !!doc.muting_details;

//
// When *new* contacts are added that have muted parents, they and their schedules should be muted.
//
// We are deciding a contact is new if:
//  - They were initially replicated *after* a mute that has happened in their parent lineage
//  - And we haven't performed any kind of mute on them before
//
const isRelevantContact = (doc, infoDoc = {}) => {
  return Boolean(doc &&
                 isContact(doc) &&
                 (isNewContactWithMutedParent(doc, infoDoc) || isMutedOffline(doc))
  );
};

const processContact = (change) => {
  if (isRelevantContact(change.doc, change.info)) {
    // process new contacts as normal
    return processNewContact(change);
  }

  return processContactMutedOffline(change);
};

const processNewContact = (change) => {
  const muted = new Date();
  mutingUtils.updateContact(change.doc, muted);
  return mutingUtils
    .updateRegistrations(utils.getSubjectIds(change.doc), muted)
    .then(() => mutingUtils.updateMutingHistory(
      change.doc,
      new Date(change.info.initial_replication_date).getTime(),
      muted
    ))
    .then(() => true);
};

const processContactMutedOffline = (change) => {
  if (!change.doc.muting_details) {
    return;
  }

  const reportId = change.doc.muting_details.offline.report_id;
  const muted = change.doc.muted ? new Date() : undefined;
  const mutingDetails = change.doc.muting_details;
  mutingUtils.updateContact(change.doc, muted);

  return mutingUtils
    .updateRegistrations(utils.getSubjectIds(change.doc), muted)
    .then(() => mutingUtils._updateMuteHistories(
      [change.doc],
      muted,
      reportId,
      { [change.doc._id]: mutingDetails })
    )
    .then(() => true);
};

module.exports = {
  name: TRANSITION_NAME,
  asynchronousOnly: true,

  init: () => {
    const forms = getConfig()[MUTE_PROPERTY];
    if (!forms || !_.isArray(forms) || !forms.length) {
      throw new Error(
        `Configuration error. Config must define have a '${CONFIG_NAME}.${MUTE_PROPERTY}' array defined.`
      );
    }
  },

  filter: (doc, info = {}) => isRelevantReport(doc, info) || isRelevantContact(doc, info),

  validate: (doc) => {
    const config = getConfig();
    return transitionUtils.validate(config, doc).then(errors => {
      if (errors && errors.length) {
        messages.addErrors(config, doc, errors, { patient: doc.patient });
        return false;
      }
      return true;
    });
  },

  onMatch: change => {
    if (change.doc.type !== 'data_record') {
      return processContact(change);
    }

    const muteState = isMuteForm(change.doc.form);
    let targetContact;

    return module.exports
      .validate(change.doc)
      .then(valid => {
        if (!valid) {
          return;
        }

        return mutingUtils
          .getContact(change.doc)
          .then(contact => {
            targetContact = contact;

            if (Boolean(contact.muted) === muteState && !contact.muting_details) {
              // don't update registrations if contact already has desired state
              // but do process muting events that have been handled on devices
              module.exports._addMsg(contact.muted ? 'already_muted' : 'already_unmuted', change.doc);
              return;
            }

            return mutingUtils.updateMuteState(contact, muteState, change.id);
          });
      })
      .then(changed => changed && module.exports._addMsg(getEventType(muteState), change.doc, targetContact))
      .catch(err => {
        if (err && err.message === 'contact_not_found') {
          module.exports._addErr('contact_not_found', change.doc);
          module.exports._addMsg('contact_not_found', change.doc);
          return;
        }

        throw(err);
      })
      .then(() => true);
  },
  _addMsg: function(eventType, doc, contact) {
    const msgConfig = _.find(getConfig().messages, { event_type: eventType });
    if (msgConfig) {
      messages.addMessage(doc, msgConfig, msgConfig.recipient, { patient: contact });
    }
  },
  _addErr: function(eventType, doc) {
    const locale = utils.getLocale(doc);
    const evConf = _.find(getConfig().messages, { event_type: eventType });

    const msg = messages.getMessage(evConf, locale);
    if (msg) {
      messages.addError(doc, msg);
    } else {
      messages.addError(doc, `Failed to complete muting request, event type "${eventType}" misconfigured.`);
    }
  }
};
