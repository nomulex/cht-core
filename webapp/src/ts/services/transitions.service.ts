import { Injectable } from '@angular/core';

import { DbService } from '@mm-services/db.service';
import { SettingsService } from '@mm-services/settings.service';
import { MutingTransition } from '@mm-services/transitions/muting.transition';

@Injectable({
  providedIn: 'root'
})
export class TransitionsService {
  constructor(
    private dbService:DbService,
    private settingsService:SettingsService,
    private mutingTransition:MutingTransition,
  ) {
  }
  private readonly AVAILABLE_TRANSITIONS = [
    { name: 'muting', transition: this.mutingTransition }
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

  private async loadSettings() {
    this.settings = (await this.settingsService.get()) || {};
  }

  private async loadTransitions() {
    await this.loadSettings();

    try {
      this.AVAILABLE_TRANSITIONS.forEach(({ name, transition }) => {
        if (!this.isEnabled(name)) {
          return;
        }

        if (!transition.init(this.settings)) {
          return;
        }

        this.loadedTransitions.push({ name, transition });
      });
    } catch (err) {
      console.error('Error loading transitions', err);
    }
  }

  private isEnabled(transitionName) {
    const transitionsConfig = this.settings.transitions || {};
    const transitionConfig = transitionsConfig[transitionName];
    if (transitionConfig && !transitionConfig.disable) {
      return true;
    }
  }

  async applyTransitions(docs) {
    await this.init();

    if (!this.loadedTransitions.length) {
      return docs;
    }

    for (const loadedTransition of this.loadedTransitions) {
      if (!loadedTransition.transition.filter(docs)) {
        console.debug('transition', loadedTransition.name, 'filter failed');
        continue;
      }

      await loadedTransition.transition.run(docs);
    }

    return docs;
  }
}
