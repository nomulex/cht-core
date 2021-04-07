import { Injectable } from '@angular/core';
import { cloneDeep } from 'lodash-es';

import * as registrationUtils from '@medic/registration-utils';
import { DbService } from '../db.service';
import { LineageModelGeneratorService } from '../lineage-model-generator.service';
import { ContactMutedService } from '../contact-muted.service';
import { ContactTypesService } from '../contact-types.service';
import { Transition } from './transition';

@Injectable({
  providedIn: 'root'
})
export class MutingTransition implements Transition {
  constructor(
    private dbService:DbService,
    private lineageModelGeneratorService:LineageModelGeneratorService,
    private contactMutedService:ContactMutedService,
    private contactTypesService:ContactTypesService,
  ) { }

  name = 'muting';
  private SETTINGS;
  private CONFIG_NAME = 'muting';
  private readonly MUTE_PROPERTY = 'mute_forms';
  private readonly UNMUTE_PROPERTY = 'unmute_forms';

  private getSettings(settings = {}) {
    this.SETTINGS = settings[this.CONFIG_NAME] || {};
  }

  private getMutingForms() {
    return this.SETTINGS[this.MUTE_PROPERTY];
  }

  private getUnmutingForms() {
    return this.SETTINGS[this.UNMUTE_PROPERTY];
  }

  init(settings) {
    this.getSettings(settings);
    const mutingForms = this.getMutingForms();
    if (!mutingForms || !Array.isArray(mutingForms) || !mutingForms.length) {
      console.warn(
        `Configuration error. Config must define have a '${this.CONFIG_NAME}.${this.MUTE_PROPERTY}' array defined.`
      );
      return false;
    }
    return true;
  }

  private isMuteForm(form) {
    return this.getMutingForms().includes(form);
  }

  private isUnmuteForm(form) {
    return this.getUnmutingForms().includes(form);
  }

  /**
   * Returns whether a document is a muting or unmuting report that should be processed.
   * We only process new reports. The muting transition should not run when existing reports are edited.
   * @param {Object} doc
   * @returns {Boolean}
   * @private
   */
  private isRelevantReport(doc) {
    // exclude docs that are not reports and existent reports.
    if (!doc || doc._rev || doc.type !== 'data_record' || !doc.form) {
      return false;
    }

    if (this.isMuteForm(doc.form) || this.isUnmuteForm(doc.form)) {
      return true;
    }

    return false;
  }

  /**
   * Returns whether a document is a new contact.
   * The muting transition should not run on when existing contacts are edited.
   * @param {Object} doc
   * @returns {Boolean}
   * @private
   */
  private isRelevantContact(doc) {
    return !doc._rev && this.contactTypesService.includes(doc);
  }

  /**
   * Returns whether any of the docs from the batch should be
   * @param docs
   */
  filter(docs) {
    const relevantDocs = docs
      .map(doc => this.isRelevantReport(doc) || this.isRelevantContact(doc))
      .filter(result => !!result);
    return !!relevantDocs.length;
  }

  private hydrateReports(reports) {
    const clones = reports.map(report => {
      const clone = cloneDeep(report);
      delete clone.contact; // don't hydrate the submitter to save time
      return clone;
    });
    return this.lineageModelGeneratorService.docs(clones);
  }

  private getContact(report, context) {
    let contact = report.patient || report.place;
    if (!contact) {
      // the report can be about a patient that we're just now creating
      const subjectIds = registrationUtils.getSubjectIds(report);
      contact = context.contacts.find(contact => subjectIds.includes(contact._id));
    }

    return contact;
  }

  private processReports(context) {
    return this.hydrateReports(context.reports).then(hydratedReports => {
      let promiseChain = Promise.resolve();
      hydratedReports.forEach(report => {
        promiseChain = promiseChain.then(() => this.processReport(report, context));
      });
      return promiseChain;
    });
  }

  private processReport(report, context) {
    const mutedState = this.isMuteForm(report.form);
    const contact = this.getContact(report, context);
    if (!contact) {
      return;
    }

    if (!!contact.muted === mutedState) {
      // already in the correct state
      return;
    }

    return this.updatedMuteState(contact, mutedState, report, context);
  }

  private updatedMuteState(contact, muted, report, context) {
    let rootContactId;

    rootContactId = contact._id;
    if (!muted) {
      let parent = contact;
      while (parent) {
        rootContactId = parent.muted ? parent._id : rootContactId;
        parent = parent.parent;
      }
    }

    return this.getContactsToProcess(rootContactId, context).then(contacts => {
      contacts.forEach(contactToUpdate => {
        const alreadyEditedContact = context.docs.find(doc => doc._id === contactToUpdate._id);
        if (alreadyEditedContact) {
          this.processContact(alreadyEditedContact, muted, report._id, context);
          return;
        }

        this.processContact(contactToUpdate, muted, report._id, context);
        context.docs.push(contactToUpdate);
      });
    });
  }

  private getContactsToProcess(contactId, context) {
    // get descendents
    return this.dbService
      .get()
      .query('medic-client/contacts_by_place', { key: [contactId], include_docs: true })
      .then(results => {
        const descendents = results.rows.map(row => row.doc);
        const found = descendents.find(contact => contact._id === contactId) ||
                      context.docs.find(contact => contact._id === contactId);
        if (!found) {
          return this.dbService.get().get(contactId).then(doc => {
            return descendents.concat(doc);
          });
        }

        return descendents;
      });
  }

  private processContacts(context) {
    if (!context.contacts.length) {
      return Promise.resolve();
    }

    const parentIds = [];
    const contactIds = context.contacts.map(contact => contact._id);
    const getParentId = contact => contact.parent?._id;
    const getIdsInLineage = contact => {
      const idsInLineage = [];
      let parent = contact.parent;
      while (parent) {
        idsInLineage.push(parent._id);
        parent = parent.parent;
      }
      return idsInLineage;
    };

    context.contacts.forEach(contact => {
      const parentId = getParentId(contact);
      if (parentId && !contactIds.includes(parentId)) {
        // don't try to hydrate fresh contacts
        parentIds.push(parentId);
      }
    });

    const knownMutedContacts = [];
    context.docs.forEach(doc => {
      if (!this.contactTypesService.includes(doc)) {
        return;
      }
      if (!this.contactMutedService.getMuted(doc)) {
        const index = parentIds.indexOf(doc._id);
        if (index >= 0) {
          parentIds.splice(index, 1);
        }
      } else {
        knownMutedContacts.push(doc);
      }
    });

    return this.lineageModelGeneratorService.ids(parentIds).then(hydratedParents => {
      knownMutedContacts.push(...hydratedParents.filter(parent => this.contactMutedService.getMuted(parent)));
      if (!knownMutedContacts.length) {
        return;
      }

      context.contacts.forEach(contact => {
        const idsInLineage = getIdsInLineage(contact);
        const mutedParent = knownMutedContacts.find(mutedParent => idsInLineage.includes(mutedParent._id));
        if (mutedParent) {
          const reportId = mutedParent.muting_details?.offline.report_id;
          this.processContact(contact, true, reportId, context);
        }
      });
    });
  }

  private processContact(contact, muted, reportId, context) {
    if (!contact.muting_details) {
      // store "online" state when first processing this doc offline
      contact.muting_details = {
        online: {
          muted: !!contact.muted,
          date: contact.muted,
        }
      };
    }

    contact.muting_details.offline = {
      muted: muted,
      date: context.mutedTimestamp,
      report_id: reportId,
    };

    if (muted) {
      contact.muted = context.mutedTimestamp;
    } else {
      delete contact.muted;
    }
  }

  onMatch(docs) {
    const context = {
      docs,
      reports: [],
      contacts: [],
      mutedTimestamp: new Date().toISOString(),
    };

    let hasMutingReport;
    let hasUnmutingReport;

    docs.forEach(doc => {
      if (this.isRelevantReport(doc)) {
        if (this.isMuteForm(doc.form)) {
          hasMutingReport = true;
        } else {
          hasUnmutingReport = true;
        }
        context.reports.push(doc);
      }

      if (this.isRelevantContact(doc)) {
        context.contacts.push(doc);
      }
    });

    if (hasMutingReport && hasUnmutingReport) {
      // we have reports that mute and unmute in the same batch
      // do something?? check if contacts are the same
    }

    return this
      .processReports(context)
      .then(() => this.processContacts(context))
      .then(() => context.docs);
  }
}

