import { Injectable } from '@angular/core';
import { cloneDeep } from 'lodash-es';

import { DbService } from '../db.service';
import { LineageModelGeneratorService } from '../lineage-model-generator.service';
import { ContactMutedService } from '../contact-muted.service';
import { ContactTypesService } from '../contact-types.service';

@Injectable({
  providedIn: 'root'
})
export class MutingTransition {
  constructor(
    private dbService:DbService,
    private lineageModelGeneratorService:LineageModelGeneratorService,
    private contactMutedService:ContactMutedService,
    private contactTypesService:ContactTypesService,
  ) { }

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
    return docs.map(doc => this.isRelevantReport(doc) || this.isRelevantContact(doc));
  }

  private hydrateReport(doc) {
    const clone = cloneDeep(doc);
    delete clone.contact; // don't hydrate the submitter to save time
    return this.lineageModelGeneratorService.docs([clone]);
  }

  private hydrateContacts(docs) {
    return this.lineageModelGeneratorService.docs(docs);
  }

  private getContact(doc) {
    return this.hydrateReport(doc).then(hydratedDoc => {
      return hydratedDoc?.patient || hydratedDoc?.place;
    });
  }

  private updateMutedState(contact, muted, reportId) {

  }



  onMatch(matchedDocs) {
    const reports = [];
    const contacts = [];



    const mutedState = this.isMuteForm(doc.form);
    // doc is a report
    return this
      .getContact(doc)
      .then(contact => {
        if (!contact) {
          return;
        }

        if (Boolean(contact.muted) === mutedState) {
          // already in the correct state
          return;
        }


      });
  }
}

