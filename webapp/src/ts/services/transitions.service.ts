import * as _ from 'lodash-es';
import { Injectable } from '@angular/core';

import { DbService } from './db.service';
import { SettingsService } from './settings.service';
import { MutingTransition } from './transitions/muting.transition';

@Injectable({
  providedIn: 'root'
})
export class TransitionsService {
  constructor(
    private dbService:DbService,
    private settingsService:SettingsService,
  ) {
  }
  private readonly AVAILABLE_TRANSITIONS = [
    ['muting', new MutingTransition(this.dbService)],
  ];
  private loadedTransitions = [];

  private inited;
  private settings;

  init() {
    if (!this.inited) {
      this.inited = this.loadTransitions();
    }
    return this.inited;
  }

  private loadSettings() {
    return this.settingsService.get().then(result => this.settings = result);
  }

  private loadTransitions() {
    return this
      .loadSettings()
      .then(() => {
        this.AVAILABLE_TRANSITIONS.forEach(([name, transition]) => {
          if (!this.isEnabled(name)) {
            return;
          }

          if (!transition.init()) {
            return;
          }

          this.loadedTransitions.push({ name, transition });
        });
      })
      .catch(err => {
        console.error('Error loading transitions', err);
      });
  }

  private isEnabled(transitionName) {
    const transitionsConfig = this.settings?.transitions || {};
    const transitionConfig = transitionsConfig[transitionName];
    if (transitionConfig && !transitionConfig.disable) {
      return true;
    }
  }
}
