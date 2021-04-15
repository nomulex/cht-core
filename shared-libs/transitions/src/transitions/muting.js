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
    !infoDoc.muting_history &&
    !isMutedOffline(doc)
  );
};

const isMutedOffline = (doc) => doc.muting_history && doc.muting_history.last_update === 'offline';

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
  let muted;
  if (isNewContactWithMutedParent(change.doc, change.info)) {
    muted = new Date();
  } else {
    muted = change.doc.muted ? new Date() : false;
  }

  return mutingUtils
    .updateRegistrations(utils.getSubjectIds(change.doc), muted)
    .then(() => mutingUtils.updateMutingHistory(
      change.doc,
      new Date(change.info.initial_replication_date).getTime(),
      muted
    ))
    .then(() => {
      mutingUtils.updateContact(change.doc, muted);
      return true;
    });
};

const runMutingOverOfflineQueue = (reportIds = []) => {
  if (!reportIds.length) {
    return Promise.resolve();
  }

  return mutingUtils.db.medic
    .allDocs({ keys: reportIds, include_docs: true })
    .then(results => {
      // exclude docs that have not been synced, have been deleted or are no longer muting reports
      // we re-run muting on these docs even if the transition already ran
      const reportDocs = results.rows
        .map(row => row.doc)
        .filter(doc => !!doc && isRelevantReport(doc, {}));

      return Promise.all([
        mutingUtils.lineage.hydrateDocs(reportDocs),
        mutingUtils.infodoc.bulkGet(reportDocs.map(doc => ({ id: doc._id }))),
      ]);
    })
    .then(([hydratedReports, infoDocs]) => {
      let promiseChain = Promise.resolve();
      hydratedReports.forEach(report => {
        promiseChain = promiseChain.then(() => runTransition(report, infoDocs));
      });
      return promiseChain;
    });
};

const runTransition = (hydratedReport, infoDocs = []) => {
  const change = {
    id: hydratedReport._id,
    doc: hydratedReport,
    info: infoDocs.find(infoDoc => infoDoc.doc_id === hydratedReport._id),
  };

  return module.exports
    .onMatch(change)
    .then(() => mutingUtils.infodoc.updateTransition(change, TRANSITION_NAME, true));
};

const processMutingEvent = (contact, change, muteState) => {
  const processedOffline = change.doc.offline_transitions &&
                           change.doc.offline_transitions[TRANSITION_NAME];
  return mutingUtils
    .updateMuteState(contact, muteState, change.id, processedOffline)
    .then(reportIds => {
      module.exports._addMsg(getEventType(muteState), change.doc, contact);

      if (processedOffline) {
        return runMutingOverOfflineQueue(reportIds);
      }
    });
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
    const contact = mutingUtils.getContact(change.doc);

    if (!contact) {
      module.exports._addErr('contact_not_found', change.doc);
      module.exports._addMsg('contact_not_found', change.doc);
      return Promise.resolve(true);
    }

    return module.exports
      .validate(change.doc)
      .then(valid => {
        if (!valid) {
          return;
        }

        if (Boolean(contact.muted) === muteState && !contact.muting_history) {
          // don't update registrations if contact already has desired state
          // but do process muting events that have been handled offline
          module.exports._addMsg(contact.muted ? 'already_muted' : 'already_unmuted', change.doc);
          return;
        }

        return processMutingEvent(contact, change, muteState);
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
