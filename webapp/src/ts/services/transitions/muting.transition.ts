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

  private isReport(doc) {
    return doc?.type === 'data_record';
  }

  private isRelevantReport(doc) {
    if (doc._rev) {
      return;
    }

    if (!this.isReport(doc)) {
      return;
    }

    if (!doc.form) {
      return;
    }

    if (this.isMuteForm(doc.form) || this.isUnmuteForm(doc.form)) {
      return true;
    }
  }

  private isRelevantContact(doc) {
    // only new contacts are relevant
    return !doc._rev && this.contactTypesService.includes(doc);
  }

  filter(docs) {
    const relevantDocs = docs
      .map(doc => this.isRelevantReport(doc) || this.isRelevantContact(doc))
      .filter(result => !!result);
    return !!relevantDocs.length;
  }

  private hydrateReports(context) {
    const clones = context.reports.map(report => {
      const clone = cloneDeep(report);
      delete clone.contact; // don't hydrate the submitter to save time
      return clone;
    });
    return this.lineageModelGeneratorService.docs(clones);
  }

  private hydrateContacts(docs) {
    return this.lineageModelGeneratorService.docs(docs);
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
    return this.hydrateContacts(context.reports).then(hydratedReports => {
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
          this.processContact(alreadyEditedContact, muted, report, context);
          return;
        }

        this.processContact(contactToUpdate, muted, report, context);
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
        if (knownMutedContacts.some(mutedParent => idsInLineage.includes(mutedParent._id))) {
          this.processContact(contact, true, false, context);
        }
      });
    });
  }

  private processContact(contact, muted, report, context) {
    if (!contact.muting_details) {
      // store "online" state when first processing this doc offline
      contact.muting_details = {
        online: {
          muted: !!contact.muted,
          date: contact.muted,
          report_id: report?._id,
        }
      };
    }

    contact.muting_details.offline = {
      muted: muted,
      muted_timestamp: context.mutedTimestamp,
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

