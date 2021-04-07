import { TestBed } from '@angular/core/testing';
import sinon from 'sinon';
import { expect } from 'chai';

import { ContactSummaryService } from '@mm-services/contact-summary.service';
import { PipesService } from '@mm-services/pipes.service';
import { SettingsService } from '@mm-services/settings.service';
import { FeedbackService } from '@mm-services/feedback.service';
import { ContactStatsService } from '@mm-services/contact-stats.service';

describe('ContactSummary service', () => {

  'use strict';

  let service;
  let Settings;
  let feedbackService;
  let contactStatsService;

  beforeEach(() => {
    Settings = sinon.stub();
    feedbackService = { submit: sinon.stub() };
    contactStatsService = {
      getVisitStats: sinon.stub()
    };
    const pipesTransform = (name, value) => {
      if (name !== 'reversify') {
        throw new Error('unknown filter');
      }
      return value.split('').reverse().join('');
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsService, useValue: { get: Settings } },
        { provide: PipesService, useValue: { transform: pipesTransform } },
        { provide: FeedbackService, useValue: feedbackService },
        { provide: ContactStatsService, useValue: contactStatsService }
      ]
    });
    service = TestBed.inject(ContactSummaryService);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns empty when no script configured', () => {
    Settings.resolves({ contact_summary: '' });
    const contact = {};
    const reports = [];
    return service.get(contact, reports).then(actual => {
      expect(actual.fields.length).to.equal(0);
      expect(actual.cards.length).to.equal(0);
    });
  });

  it('evals script with `reports` and `contact` in scope', () => {
    const script = `return { fields: [
                      { label: "Notes", value: "Hello " + contact.name },
                      { label: "Num reports", value: reports.length }
                    ] };`;
    Settings.resolves({ contact_summary: script });
    const contact = { name: 'jack' };
    const reports = [ { _id: 1 }, { _id: 2} ];
    return service.get(contact, reports).then(actual => {
      expect(actual.fields.length).to.equal(2);
      expect(actual.fields[0].label).to.equal('Notes');
      expect(actual.fields[0].value).to.equal('Hello jack');
      expect(actual.fields[1].label).to.equal('Num reports');
      expect(actual.fields[1].value).to.equal(2);
      expect(actual.cards.length).to.equal(0);
    });
  });

  it('applies filters to values', () => {
    const script = `return { fields: [
                      { label: "Notes", value: "Hello", filter: "reversify" }
                    ] };`;
    Settings.resolves({ contact_summary: script });
    const contact = {};
    const reports = [];
    return service.get(contact, reports).then(actual => {
      expect(actual.fields.length).to.equal(1);
      expect(actual.fields[0].label).to.equal('Notes');
      expect(actual.fields[0].value).to.equal('olleH');
      expect(actual.cards.length).to.equal(0);
    });
  });

  it('does not crash when contact-summary function returns arrays with undefined elements #4125', () => {
    const script = `
                   return {
                     fields: [undefined],
                     cards: [undefined]
                   }
                   `;
    Settings.resolves({ contact_summary: script });
    const contact = {};
    const reports = [];
    return service.get(contact, reports).then(actual => {
      expect(actual.fields).to.deep.equal([undefined]);
      expect(actual.cards).to.deep.equal([undefined]);
    });
  });

  it('does not crash when contact-summary function returns non-array elements #4125', () => {
    const script = `
                   return {
                     fields: 'alpha',
                     cards: [{ fields: 'beta' }]
                   }
                   `;
    Settings.resolves({ contact_summary: script });
    const contact = {};
    const reports = [];
    return service.get(contact, reports).then(actual => {
      expect(actual.fields).to.be.an('array');
      expect(actual.fields.length).to.equal(0);
      expect(actual.cards).to.be.an('array');
      expect(actual.cards.length).to.equal(1);
      expect(actual.cards[0].fields).to.equal('beta');
    });
  });

  it('does crash when contact summary throws an error', async () => {
    const consoleErrorMock = sinon.stub(console, 'error');
    const script = `return contact.some.field;`;
    const contact = {};
    Settings.resolves({ contact_summary: script });

    await service.get(contact);

    // First error catch
    expect(consoleErrorMock.callCount).to.equal(2);
    expect(consoleErrorMock.args[0][0].startsWith('Configuration error in contact-summary')).to.be.true;
    expect(feedbackService.submit.callCount).to.equal(1);
    expect(feedbackService.submit.args[0][0])
      .to.equal('Configuration error in contact-summary function: Cannot read property \'field\' of undefined');

    // Second catch when error bubbled up
    expect(consoleErrorMock.args[1][0]).to.equal(
      'Error when getting contact summary:',
      'Error: Configuration error'
    );
  });

  it('should pass targets to the ContactSummary script', () => {
    const script = `
    return {
      fields: [contact.name, lineage[0].name],
      cards: [
        { fields: reports[0].type },
        { fields: targetDoc.date_updated }
      ],
    }
    `;

    Settings.resolves({ contact_summary: script });
    const contact = { name: 'boa' };
    const reports = [{ type: 'data' }, { type: 'record' }];
    const lineage = [{ name: 'parent' }, { name: 'grandparent' }];
    const targetDoc = { date_updated: 'yesterday', targets: [{ id: 'target', type: 'count' }] };

    return service.get(contact, reports, lineage, targetDoc).then(contactSummary => {
      expect(contactSummary).to.deep.equal({
        fields: ['boa', 'parent'],
        cards: [
          { fields: 'data' },
          { fields: 'yesterday' },
        ]
      });
    });
  });

  it('should pass stats to the ContactSummary script', async () => {
    const contact = { _id: 1 };
    const reports = [];
    const script = `
    return { fields: [
      { label: "Visits count", value: stats.visit.count },
      { label: "Visit goal", value: stats.visit.countGoal },
      { label: "Last visited", value: stats.visit.lastVisitedDate }
    ] };
    `;

    Settings.resolves({ contact_summary: script });
    contactStatsService.getVisitStats.returns({ count: 5, countGoal: 10, lastVisitedDate: 1617729474090 });

    const contactSummary = await service.get(contact, reports);

    expect(contactSummary).to.deep.equal({
      cards: [],
      fields: [
        { label: 'Visits count', value: 5 },
        { label: 'Visit goal', value: 10 },
        { label: 'Last visited', value: 1617729474090 }
      ]
    });
  });
});
