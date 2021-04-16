import { Injectable } from '@angular/core';
import { cloneDeep } from 'lodash-es';

import * as registrationUtils from '@medic/registration-utils';
import * as validation from '@medic/validation';
import { DbService } from '@mm-services/db.service';
import { LineageModelGeneratorService } from '@mm-services/lineage-model-generator.service';
import { ContactMutedService } from '@mm-services/contact-muted.service';
import { ContactTypesService } from '@mm-services/contact-types.service';
import { TransitionInterface } from '@mm-services/transitions/transition';

@Injectable({
  providedIn: 'root'
})
export class MutingTransition implements TransitionInterface {
  constructor(
    private dbService:DbService,
    private lineageModelGeneratorService:LineageModelGeneratorService,
    private contactMutedService:ContactMutedService,
    private contactTypesService:ContactTypesService,
  ) { }

  readonly name = 'muting';

  private transitionConfig;
  private readonly CONFIG_NAME = 'muting';
  private readonly MUTE_PROPERTY = 'mute_forms';
  private readonly UNMUTE_PROPERTY = 'unmute_forms';
  private readonly OFFLINE_LAST_UPDATE = 'offline';

  private loadSettings(settings = {}) {
    this.transitionConfig = settings[this.CONFIG_NAME] || {};
  }

  private getMutingForms() {
    return this.transitionConfig[this.MUTE_PROPERTY];
  }

  private getUnmutingForms() {
    return this.transitionConfig[this.UNMUTE_PROPERTY];
  }

  init(settings) {
    this.loadSettings(settings);
    if (!this.transitionConfig.offline_muting) {
      return false;
    }

    const mutingForms = this.getMutingForms();
    if (!mutingForms || !Array.isArray(mutingForms) || !mutingForms.length) {
      console.warn(
        `Configuration error. Config must define have a '${this.CONFIG_NAME}.${this.MUTE_PROPERTY}' array defined.`
      );
      return false;
    }
    // todo do we even add messages offline??
    const translate = (key) => key;
    validation.init({ settings, db: { medic: this.dbService.get() }, translate, logger: console });
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
    const clonedReports = reports.map(report => {
      const reportClone = cloneDeep(report);
      delete reportClone.contact; // don't hydrate the submitter to save time, we already know who submitted these
      return reportClone;
    });
    return this.lineageModelGeneratorService.docs(clonedReports);
  }

  private async hydrateContacts(context) {
    // this works out of the box, even for contacts that don't exist, because the hydration script consolidates all
    // "known" contacts into a single array, which includes the ones that we pass as arguments
    const hydratedContacts = await this.lineageModelGeneratorService.docs(context.contacts);

    hydratedContacts.forEach(contact => {
      context.hydratedContacts[contact._id] = contact;
      let parent = contact.parent;
      while (parent) {
        context.hydratedContacts[parent._id] = parent;
        parent = parent.parent;
      }
    });
  }

  private async isValid(report) {
    const validations = this.transitionConfig.validations?.list;
    const errors = await validation.validate(report, validations);
    // todo add the errors on the doc?
    return !errors || !errors.length;
  }

  private getSubject(report, context) {
    let contact = report.patient || report.place;
    if (!contact) {
      // the report can be about a patient or place that we're just now creating
      const subjectIds = registrationUtils.getSubjectIds(report);
      const newContact = context.contacts.find(contact => subjectIds.includes(contact._id));
      if (newContact) {
        contact = context.hydratedContacts[newContact._id];
      }
    }

    return contact;
  }

  private async processReports(context) {
    const hydratedReports = await this.hydrateReports(context.reports);

    for (const hydratedReport of hydratedReports) {
      const originalReport = context.reports.find(report => hydratedReport._id === report._id);
      await this.processReport(originalReport, hydratedReport, context);
    }
  }

  private processReport(report, hydratedReport, context) {
    const mutedState = this.isMuteForm(report.form);
    const subject = this.getSubject(hydratedReport, context);
    if (!subject || !!subject.muted === mutedState) {
      // no subject or already in the correct state
      return Promise.resolve();
    }

    report.offline_transitions = report.offline_transitions || {};
    report.offline_transitions.muting = true;

    return this.updatedMuteState(subject, mutedState, report, context);
  }

  private async updatedMuteState(contact, muted, report, context) {
    let rootContactId;

    // when muting, mute the contact itself + all descendents
    rootContactId = contact._id;
    // when unmuting, find the topmost muted parent and unmute it and all its descendents
    if (!muted) {
      let parent = contact;
      while (parent) {
        rootContactId = parent.muted ? parent._id : rootContactId;
        parent = parent.parent;
      }
    }

    const contactsToProcess = await this.getContactsToProcess(contact, rootContactId, context);
    contactsToProcess.forEach(contactToProcess => {
      const knownContact = context.docs.find(doc => doc._id === contactToProcess._id);
      if (knownContact) {
        this.processContact(knownContact, muted, report._id, context);
        return;
      }

      this.processContact(contactToProcess, muted, report._id, context);
      context.docs.push(contactToProcess);
    });
  }

  private getRootContact(rootContactId, context) {
    const knownContact = context.docs.find(doc => doc._id === rootContactId);
    if (knownContact) {
      return Promise.resolve(knownContact);
    }

    return this.dbService.get().get(rootContactId);
  }

  private async getDescendents(rootContactId) {
    const results = await this.dbService
      .get()
      .query('medic-client/contacts_by_place', { key: [rootContactId], include_docs: true });

    return results.rows.map(row => row.doc);
  }

  private async getContactsToProcess(contact, rootContactId, context) {
    const descendents = await this.getDescendents(rootContactId);
    const rootContact = await this.getRootContact(rootContactId, context);

    descendents.push(rootContact);
    const foundContact = descendents.find(descendent => descendent._id === contact._id);
    if (!foundContact) {
      descendents.push(contact);
    }

    return descendents;
  }

  private getLastMutingEvent(contact) {
    return this.lastUpdatedOffline(contact) && contact?.muting_history?.offline?.slice(-1)[0] || {};
  }
  private lastUpdatedOffline(contact) {
    return contact?.muting_history?.last_update === this.OFFLINE_LAST_UPDATE;
  }

  private processContacts(context) {
    if (!context.contacts.length) {
      return;
    }

    context.contacts.forEach(contact => {
      const hydratedContact = context.hydratedContacts[contact._id];
      const mutedParent = this.contactMutedService.getMutedParent(hydratedContact);
      if (mutedParent) {
        const updatedMutedParent = context.hydratedContacts[mutedParent._id];
        // store reportId if the parent was last muted offline
        // if the parent was last muted online, we don't have access to this information
        const reportId = this.lastUpdatedOffline(updatedMutedParent) ?
          this.getLastMutingEvent(updatedMutedParent).report_id :
          undefined;

        this.processContact(contact, true, reportId, context);
      }
    });
  }

  private processContact(contact, muted, reportId, context) {
    if (!contact.muting_history) {
      // store "online" state when first processing this doc offline
      contact.muting_history = {
        online: {
          muted: !!contact.muted,
          date: contact.muted,
        },
        offline: [],
        last_update: this.OFFLINE_LAST_UPDATE,
      };
    }

    if (muted) {
      contact.muted = context.mutedTimestamp;
    } else {
      delete contact.muted;
    }

    const mutingEvent = {
      muted: muted,
      date: context.mutedTimestamp,
      report_id: reportId,
    };
    const lastMutingEvent = this.getLastMutingEvent(contact);
    if (lastMutingEvent &&
      lastMutingEvent.muted === mutingEvent.muted &&
      lastMutingEvent.date === mutingEvent.date &&
      lastMutingEvent.report_id === mutingEvent.report_id) {
      // don't duplicate the muting events
      return;
    }

    contact.muting_history.offline.push(mutingEvent);
    // consolidate muted state in hydratedContacts
    if (context.hydratedContacts[contact._id]) {
      context.hydratedContacts[contact._id].muted = contact.muted;
      context.hydratedContacts[contact._id].muting_history = contact.muting_history;
    }
  }

  async run(docs) {
    const context = {
      docs,
      reports: [],
      contacts: [],
      hydratedContacts: {},
      mutedTimestamp: new Date().toISOString(),
    };

    let hasMutingReport;
    let hasUnmutingReport;

    for (const doc of docs) {
      if (this.isRelevantContact(doc)) {
        context.contacts.push(doc);
        continue;
      }

      if (this.isRelevantReport(doc)) {
        const valid = await this.isValid(doc);
        if (!valid) {
          continue;
        }

        if (this.isMuteForm(doc.form)) {
          hasMutingReport = true;
        } else {
          hasUnmutingReport = true;
        }
        context.reports.push(doc);
      }
    }

    if (hasMutingReport && hasUnmutingReport) {
      // we have reports that mute and unmute in the same batch, so only unmute!
      context.reports = context.reports.filter(report => this.isUnmuteForm(report));
    }

    await this.hydrateContacts(context);
    await this.processReports(context);
    this.processContacts(context);

    return docs;
  }
}

