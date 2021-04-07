const db = require('../db');
const lineage = require('@medic/lineage')(Promise, db.medic);
const utils = require('./utils');
const moment = require('moment');
const infodoc = require('@medic/infodoc');

infodoc.initLib(db.medic, db.sentinel);

const BATCH_SIZE = 50;

const getContact = doc => {
  const contact = doc.patient || doc.place;

  if (!contact) {
    return Promise.reject(new Error('contact_not_found'));
  }

  return Promise.resolve(contact);
};

const getDescendants = (contactId) => {
  return db.medic
    .query('medic/contacts_by_depth', { key: [contactId] })
    .then(result => result.rows.map(row => row.id));
};

const updateRegistration = (dataRecord, muted) => {
  return muted ? muteUnsentMessages(dataRecord) : unmuteMessages(dataRecord);
};

const getOfflineMutingDetails = (contacts) => {
  const mutingDetails = {};
  contacts.forEach(contact => {
    mutingDetails[contact._id] = contact.muting_details;
  });
  return mutingDetails;
};

const updateContacts = (contacts, muted) => {
  if (!contacts.length) {
    return Promise.resolve();
  }

  contacts.forEach(contact => updateContact(contact, muted));
  return db.medic.bulkDocs(contacts);
};

const updateContact = (contact, muted) => {
  if (muted) {
    contact.muted = muted;
  } else {
    delete contact.muted;
  }
  delete contact.muting_details;

  return contact;
};

const updateRegistrations = (subjectIds, muted) => {
  if (!subjectIds.length) {
    return Promise.resolve();
  }

  return utils
    .getReportsBySubject({ ids: subjectIds, registrations: true })
    .then(registrations => {
      registrations = registrations.filter(registration => updateRegistration(registration, muted));
      if (!registrations.length) {
        return;
      }
      return db.medic.bulkDocs(registrations);
    });
};

const getContactsAndSubjectIds = (contactIds, muted) => {
  return db.medic
    .allDocs({ keys: contactIds, include_docs: true })
    .then(result => {
      const contacts   = [];
      const subjectIds = [];

      result.rows.forEach(row => {
        if (!row.doc || Boolean(row.doc.muted) === Boolean(muted)) {
          return;
        }
        contacts.push(row.doc);
        subjectIds.push(...utils.getSubjectIds(row.doc));
      });

      return { contacts, subjectIds };
    });
};

const updateMutingHistories = (contacts, muted, reportId, offlineMutingDetails = {}) => {
  if (!contacts.length) {
    return Promise.resolve();
  }

  return infodoc
    .bulkGet(contacts.map(contact => ({ id: contact._id, doc: contact})))
    .then(infoDocs => {
      return infoDocs.map((info, idx) => {
        const offlineMutingDetail = offlineMutingDetails[contacts[idx]._id];
        return addMutingHistory(info, muted, reportId, offlineMutingDetail);
      });
    })
    .then(infoDocs => infodoc.bulkUpdate(infoDocs));
};

const updateMutingHistory = (contact, initialReplicationDatetime, muted) => {
  const mutedParentId = isMutedInLineage(contact, initialReplicationDatetime);

  return infodoc
    .get({ id: mutedParentId })
    .then(infoDoc => {
      const reportId = infoDoc &&
                       infoDoc.muting_history &&
                       infoDoc.muting_history[infoDoc.muting_history.length - 1] &&
                       infoDoc.muting_history[infoDoc.muting_history.length - 1].report_id;

      return updateMutingHistories([contact], muted, reportId);
    });
};

const addMutingHistory = (info, muted, reportId, offlineMutingDetail) => {
  info.muting_history = info.muting_history || [];

  if (offlineMutingDetail && offlineMutingDetail.offline) {
    offlineMutingDetail.offline.offline = true;
    info.muting_history.push(offlineMutingDetail.offline);
  }

  info.muting_history.push({
    muted: !!muted,
    date: muted || moment(),
    report_id: reportId
  });

  return info;
};

const updateMuteState = (contact, muted, reportId) => {
  muted = muted && moment();

  let rootContactId;
  if (muted) {
    rootContactId = contact._id;
  } else {
    let parent = contact;
    while (parent) {
      rootContactId = parent.muted ? parent._id : rootContactId;
      parent = parent.parent;
    }
  }

  return getDescendants(rootContactId).then(contactIds => {
    const batches = [];
    while (contactIds.length) {
      batches.push(contactIds.splice(0, BATCH_SIZE));
    }

    return batches
      .reduce((promise, batch) => {
        return promise
          .then(() => getContactsAndSubjectIds(batch, muted))
          .then(result => {
            const offlineMutingDetails = getOfflineMutingDetails(result.contacts);
            return Promise.all([
              updateContacts(result.contacts, muted),
              updateRegistrations(result.subjectIds, muted),
              updateMutingHistories(result.contacts, muted, reportId, offlineMutingDetails)
            ]);
          });
      }, Promise.resolve());
  });
};

const isMutedInLineage = (doc, beforeMillis) => {
  let parent = doc && doc.parent;
  while (parent) {
    if (parent.muted && (beforeMillis ? new Date(parent.muted).getTime() <= beforeMillis : true)) {
      return parent._id;
    }
    parent = parent.parent;
  }
  return false;
};

const unmuteMessages = doc => {
  // only schedule tasks that have a due date in the present or future
  return utils.setTasksStates(doc, 'scheduled', task => {
    return task.state === 'muted' &&
           moment(task.due) >= moment().startOf('day');
  });
};

const muteUnsentMessages = doc => {
  return utils.setTasksStates(doc, 'muted', task => {
    return task.state === 'scheduled' ||
           task.state === 'pending';
  });
};

module.exports = {
  updateMuteState: updateMuteState,
  updateContact: updateContact,
  getContact: getContact,
  updateRegistrations: updateRegistrations,
  isMutedInLineage: isMutedInLineage,
  unmuteMessages: unmuteMessages,
  muteUnsentMessages: muteUnsentMessages,
  updateMutingHistory: updateMutingHistory,
  _getContactsAndSubjectIds: getContactsAndSubjectIds,
  _updateContacts: updateContacts,
  _updateMuteHistories: updateMutingHistories,
  _lineage: lineage
};
