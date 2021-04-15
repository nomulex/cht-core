const _ = require('lodash');
const db = require('../db');
const lineage = require('@medic/lineage')(Promise, db.medic);
const utils = require('./utils');
const moment = require('moment');
const infodoc = require('@medic/infodoc');

infodoc.initLib(db.medic, db.sentinel);

const BATCH_SIZE = 50;

const getContact = doc => doc.patient || doc.place;

const getDescendants = (contactId) => {
  return db.medic
    .query('medic/contacts_by_depth', { key: [contactId] })
    .then(result => result.rows.map(row => row.id));
};

const updateRegistration = (dataRecord, muted) => {
  return muted ? muteUnsentMessages(dataRecord) : unmuteMessages(dataRecord);
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

  if (contact.muting_history) {
    contact.muting_history.online = {
      muted: !!muted,
      date: muted || new Date().getTime(),
    };
    contact.muting_history.last_update = 'online';
  }

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

const updateMutingHistories = (contacts, muted, reportId) => {
  if (!contacts.length) {
    return Promise.resolve();
  }

  return infodoc
    .bulkGet(contacts.map(contact => ({ id: contact._id, doc: contact})))
    .then(infoDocs => infoDocs.map((info) => addMutingHistory(info, muted, reportId)))
    .then(infoDocs => infodoc.bulkUpdate(infoDocs));
};

const getLastMutingEventReportId = mutingHistory => {
  return mutingHistory &&
         mutingHistory[mutingHistory.length - 1] &&
         mutingHistory[mutingHistory.length - 1].report_id;
};

const updateMutingHistory = (contact, initialReplicationDatetime, muted) => {
  if (contact.muting_history && contact.muting_history.last_update === 'offline') {
    const reportId = contact.muting_history.offline && getLastMutingEventReportId(contact.muting_history.offline);
    return updateMutingHistories([contact], muted, reportId);
  }

  const mutedParentId = isMutedInLineage(contact, initialReplicationDatetime);

  return infodoc
    .get({ id: mutedParentId })
    .then(infoDoc => {
      const reportId = infoDoc && getLastMutingEventReportId(infoDoc.muting_history);
      return updateMutingHistories([contact], muted, reportId);
    });
};

const addMutingHistory = (info, muted, reportId) => {
  info.muting_history = info.muting_history || [];

  info.muting_history.push({
    muted: !!muted,
    date: muted || moment(),
    report_id: reportId
  });

  return info;
};

const updateMuteState = (contact, muted, reportId, replayOfflineMuting = false) => {
  muted = muted && moment();

  let rootContactId = contact._id;
  if (!muted) {
    let parent = contact;
    // get topmost muted ancestor
    while (parent) {
      rootContactId = parent.muted ? parent._id : rootContactId;
      parent = parent.parent;
    }
  }

  const offlineMutingReplayQueue = [];

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
            if (replayOfflineMuting) {
              offlineMutingReplayQueue.push(...getOfflineMutingEventsToReplay(result.contacts, reportId));
            }

            return Promise.all([
              updateContacts(result.contacts, muted),
              updateRegistrations(result.subjectIds, muted),
              updateMutingHistories(result.contacts, muted, reportId),
            ]);
          });
      }, Promise.resolve())
      .then(() => sortReplayQueue(offlineMutingReplayQueue));
  });
};

// todo add jsdoc
const sortReplayQueue = (replayEvents) => {
  const compareDates = (a, b) => String(a.date).localeCompare(String(b.date));
  const sortedQueue = replayEvents.sort(compareDates).map(entry => entry.report_id);
  // _uniq guarantees sorted results, first occurrence is selected which is what we want!
  return _.uniq(sortedQueue);
};

// todo add jsodc
// add comment about how this works and the drawbacks of mixing online and offline muting!
const getOfflineMutingEventsToReplay = (contacts, reportId) => {
  const offlineMutingEvents = [];
  contacts.forEach(contact => {
    if (!contact.muting_history || !contact.muting_history.offline || !contact.muting_history.offline.length) {
      return;
    }
    let found = false;
    // todo add comment
    contact.muting_history.offline.forEach(mutingHistory => {
      if (!mutingHistory.report_id || !mutingHistory.date) {
        return;
      }

      if (found) {
        offlineMutingEvents.push({ report_id: mutingHistory.report_id, date: mutingHistory.date });
      } else if (mutingHistory.report_id === reportId) {
        found = true;
      }
    });
  });

  return offlineMutingEvents;
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
  updateMuteState,
  updateContact,
  getContact,
  updateRegistrations,
  isMutedInLineage,
  unmuteMessages,
  muteUnsentMessages,
  updateMutingHistory,
  _getContactsAndSubjectIds: getContactsAndSubjectIds,
  _updateContacts: updateContacts,
  _updateMuteHistories: updateMutingHistories,
  lineage,
  db,
  infodoc,
};
