const sinon = require('sinon');
const config = require('../../../src/config');
const chai = require('chai');
const transitionUtils = require('../../../src/transitions/utils');
const mutingUtils = require('../../../src/lib/muting_utils');
const transition = require('../../../src/transitions/muting');
const utils = require('../../../src/lib/utils');

describe('Muting transition', () => {
  afterEach(() => sinon.restore());
  beforeEach(() => {
    sinon.stub(config, 'get');
    sinon.stub(config, 'getAll').returns({ });
    sinon.stub(transitionUtils, 'hasRun');

    sinon.stub(mutingUtils, 'isMutedInLineage');
    sinon.stub(mutingUtils, 'updateContact');
    sinon.stub(mutingUtils, 'updateRegistrations');
    sinon.stub(mutingUtils, 'updateMuteState');
    sinon.stub(mutingUtils, 'getContact');
    sinon.stub(mutingUtils, 'updateMutingHistory');

    sinon.stub(utils, 'getSubjectIds');
  });

  describe('init', () => {
    it('should throw an error when config is incorrect', () => {
      config.get.returns({});
      chai.expect(transition.init).to.throw(Error, 'Configuration error');

      config.get.returns({ muting: {} });
      chai.expect(transition.init).to.throw('Configuration error');

      config.get.returns({ muting: { mute_forms: 'test' } });
      chai.expect(transition.init).to.throw('Configuration error');
    });

    it('should not throw an error when config is correct', () => {
      config.get.returns({ mute_forms: ['formA', 'formB'] });
      chai.expect(transition.init).to.not.throw();
      chai.expect(config.get.callCount).to.equal(1);
      chai.expect(config.get.args[0]).to.deep.equal(['muting']);
    });
  });

  describe('filter', () => {
    it('should return false for invalid docs', () => {
      config.get.withArgs('muting').returns({ mute_forms: ['formA', 'formB'], unmute_forms: ['formC', 'formD'] });
      config.getAll.returns({ contact_types: [] });
      transitionUtils.hasRun.returns(false);

      chai.expect(transition.filter()).to.equal(false);
      chai.expect(transition.filter({})).to.equal(false);
      chai.expect(transition.filter({ type: 'person' })).to.equal(false);
      chai.expect(transition.filter({ type: 'data_record' })).to.equal(false);
      chai.expect(transition.filter({ type: 'data_record', form: 'test' })).to.equal(false);
      chai.expect(transition.filter({ type: 'data_record', form: 'test', fields: {} })).to.equal(false);
      chai.expect(transition.filter({ type: 'data_record', form: 'test', fields: { patient_id: 'a'} })).to.equal(false);
      chai.expect(transition.filter({ type: 'data_record', form: 'test', fields: { place_id: 'a'} })).to.equal(false);
    });

    it('should return false for valid docs but not valid submissions', () => {
      config.get.withArgs('contact_types').returns([{ id: 'person' }, { id: 'clinic' } ]);
      config.get.withArgs('muting').returns({ mute_forms: ['formA', 'formB'], unmute_forms: ['formC', 'formD'] });
      transitionUtils.hasRun.returns(false);
      sinon.stub(utils, 'isValidSubmission').returns(false);

      chai.expect(transition.filter({ type: 'data_record', form: 'formC'})).to.equal(false);
      chai.expect(transition.filter({ type: 'data_record', form: 'formA'})).to.equal(false);
      chai.expect(utils.isValidSubmission.callCount).to.equal(2);
    });

    it('should return true for valid docs and valid submissions', () => {
      config.get.returns({ mute_forms: ['formA', 'formB'], unmute_forms: ['formC', 'formD'] });
      transitionUtils.hasRun.returns(false);
      sinon.stub(utils, 'isValidSubmission').returns(true);

      chai.expect(transition.filter({ type: 'data_record', form: 'formC'})).to.equal(true);
      chai.expect(transition.filter({ type: 'data_record', form: 'formA'})).to.equal(true);
      chai.expect(utils.isValidSubmission.callCount).to.equal(2);
    });

    it('should return false for invalid contacts', () => {
      config.getAll.returns({ contact_types: [{ id: 'person' }, { id: 'clinic' } ] });
      mutingUtils.isMutedInLineage.returns(false);
      chai.expect(transition.filter({ muted: false }, {})).to.equal(false); // not a contact
      chai.expect(transition.filter({ muted: false, type: 'something' }, {})).to.equal(false); // not a contact
      chai.expect(transition.filter({ muted: false, type: 'person'}, { initial_replication_date: 1})).to.equal(false);
      chai.expect(transition.filter({ muted: false, type: 'clinic'}, { initial_replication_date: 2})).to.equal(false);
      chai.expect(
        transition.filter({ muted: false, type: 'thing', contact_type: 'other thing'}, { initial_replication_date: 2})
      ).to.equal(false); // not a contact, doesn't even call isMutedInLineage
      chai.expect(
        transition.filter({ muted: false, type: 'contact', contact_type: 'other thing'}, { initial_replication_date: 2})
      ).to.equal(false); // not a valid contact type,  doesn't even call isMutedInLineage
      chai.expect(mutingUtils.isMutedInLineage.callCount).to.equal(2);
      chai.expect(mutingUtils.isMutedInLineage.args).to.deep.equal([
        [{ muted: false, type: 'person' }, 1],
        [{ muted: false, type: 'clinic' }, 2]
      ]);
    });

    it('should return true for new contacts under muted parents', () => {
      config.getAll.returns({
        contact_types: [{ id: 'person' }, { id: 'clinic' }, { id: 'health_center' }, { id: 'district_hospital' } ]
      });
      mutingUtils.isMutedInLineage.returns(true);
      chai.expect(transition.filter({ muted: false, type: 'person' }, {initial_replication_date: 1}))
        .to.equal(true);
      chai.expect(transition.filter({ muted: false, type: 'clinic' }, {initial_replication_date: 2}))
        .to.equal(true);
      chai.expect(transition.filter({ muted: false, type: 'district_hospital' }, {initial_replication_date: 3}))
        .to.equal(true);
      chai.expect(transition.filter({ muted: false, type: 'health_center' }, {initial_replication_date: 4}))
        .to.equal(true);
      chai.expect(transition.filter({ muted: false, type: 'clinic', contact_type: 'm' }, {initial_replication_date: 7}))
        .to.equal(true);

      chai.expect(mutingUtils.isMutedInLineage.callCount).to.equal(5);
      chai.expect(mutingUtils.isMutedInLineage.args).to.deep.equal([
        [{ muted: false, type: 'person' }, 1],
        [{ muted: false, type: 'clinic' }, 2],
        [{ muted: false, type: 'district_hospital' }, 3],
        [{ muted: false, type: 'health_center' }, 4],
        [{ muted: false, type: 'clinic', contact_type: 'm' }, 7]
      ]);
    });

    it('should return true for contacts muted offline', () => {
      config.getAll.returns({
        contact_types: [{ id: 'person' }, { id: 'clinic' }, { id: 'health_center' }, { id: 'district_hospital' } ]
      });
      const contactMutedOffline = {
        type: 'person',
        muted: true,
        muting_history: {
          last_update: 'offline',
        },
      };
      const contactMutedOnline = {
        type: 'person',
        muted: true,
        muting_history: {
          online: { muted: true, date: 20 },
          offline: [{ muted: true, date: 10 }],
          last_update: 'online',
        },
      };
      chai.expect(transition.filter(contactMutedOffline )).to.equal(true);
      chai.expect(transition.filter(contactMutedOnline )).to.equal(false);
    });

    it('should return false for previously muted contacts', () => {
      // Even though one of its parents have been muted
      mutingUtils.isMutedInLineage.returns(true);
      // because it's been muted before we want to ignore it
      chai.expect(transition.filter({ muted: false, type: 'person' }, { muting_history: [{some: 'history'}]}))
        .to.equal(false);
    });
  });

  describe('onMatch', () => {
    describe('new contacts', () => {
      let clock;

      beforeEach(() => {
        clock = sinon.useFakeTimers();
        config.getAll.returns({ contact_types: [{ id: 'person' }] });
      });
      afterEach(() => clock.restore());

      it('should update the contact', () => {
        const doc = { _id: 'id', type: 'person', patient_id: 'patient' };
        const info = { initial_replication_date: 'unknown' };
        mutingUtils.updateRegistrations.resolves();
        utils.getSubjectIds.returns(['id', 'patient']);
        mutingUtils.updateMutingHistory.resolves();
        mutingUtils.isMutedInLineage.returns(true);

        return transition.onMatch({ doc, info }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.updateContact.callCount).to.equal(1);
          chai.expect(mutingUtils.updateContact.args[0]).to.deep.equal([doc, new Date()]);
          chai.expect(utils.getSubjectIds.callCount).to.equal(1);
          chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([doc]);
          chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
          chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['id', 'patient'], new Date()]);
          chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMutingHistory.args[0]).to.deep.equal([doc, NaN, new Date()]);
        });
      });

      it('should throw updateRegistrations errors', () => {
        const doc = { _id: 'id', type: 'person', patient_id: 'patient' };
        mutingUtils.updateRegistrations.rejects({ some: 'error' });
        utils.getSubjectIds.returns(['id', 'patient']);
        mutingUtils.updateMutingHistory.resolves();
        mutingUtils.isMutedInLineage.returns(true);

        return transition
          .onMatch({ doc })
          .then(() => chai.expect(true).to.equal('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.updateContact.callCount).to.equal(0);
            chai.expect(utils.getSubjectIds.callCount).to.equal(1);
            chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([doc]);
            chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
            chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['id', 'patient'], new Date()]);
            chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(0);
          });
      });

      it('should throw updateMutingHistory errors', () => {
        const doc = { _id: 'id', type: 'person', patient_id: 'patient' };
        const info = { initial_replication_date: 'unknown' };
        mutingUtils.updateRegistrations.resolves();
        utils.getSubjectIds.returns(['id', 'patient']);
        mutingUtils.updateMutingHistory.rejects({ some: 'error' });
        mutingUtils.isMutedInLineage.returns(true);

        return transition
          .onMatch({ doc, info })
          .then(() => chai.expect(true).to.equal('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.updateContact.callCount).to.equal(0);
            chai.expect(utils.getSubjectIds.callCount).to.equal(1);
            chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([doc]);
            chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
            chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['id', 'patient'], new Date()]);
            chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(1);
            chai.expect(mutingUtils.updateMutingHistory.args[0]).to.deep.equal([doc, NaN, new Date()]);
          });
      });
    });

    describe('contacts muted offline', () => {
      let clock;

      beforeEach(() => {
        clock = sinon.useFakeTimers();
        config.getAll.returns({ contact_types: [{ id: 'person' }] });
      });
      afterEach(() => clock.restore());

      it('should update the contact when muted', () => {
        const info = { initial_replication_date: 'unknown' };
        const doc = {
          _id: 'patient',
          type: 'person',
          muted: true,
          muting_history: {
            online: { muted: false },
            offline: [
              { muted: true, date: 100, report_id: 'report1' },
              { muted: false, date: 200, report_id: 'report2' },
              { muted: true, date: 300, report_id: 'report3' },
            ],
            last_update: 'offline',
          }
        };

        mutingUtils.updateRegistrations.resolves();
        utils.getSubjectIds.returns(['patient']);
        mutingUtils.updateMutingHistory.resolves();
        mutingUtils.isMutedInLineage.returns(true);

        return transition.onMatch({ doc, info }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.updateContact.callCount).to.equal(1);
          chai.expect(mutingUtils.updateContact.args[0]).to.deep.equal([ doc, new Date()]);
          chai.expect(utils.getSubjectIds.callCount).to.equal(1);
          chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([ doc]);
          chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
          chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['patient'], new Date()]);
          chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMutingHistory.args[0]).to.deep.equal([ doc, NaN, new Date()]);
        });
      });

      it('should update the contact when unmuted', () => {
        const info = { initial_replication_date: 'unknown' };
        const doc = {
          _id: 'patient',
          type: 'person',
          muting_history: {
            online: { muted: true },
            offline: [
              { muted: true, date: 100, report_id: 'report1' },
              { muted: false, date: 200, report_id: 'report2' },
              { muted: true, date: 300, report_id: 'report3' },
            ],
            last_update: 'offline',
          }
        };

        mutingUtils.updateRegistrations.resolves();
        utils.getSubjectIds.returns(['patient']);
        mutingUtils.updateMutingHistory.resolves();
        mutingUtils.isMutedInLineage.returns(true);

        return transition.onMatch({ doc, info }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.updateContact.callCount).to.equal(1);
          chai.expect(mutingUtils.updateContact.args[0]).to.deep.equal([ doc, false]);
          chai.expect(utils.getSubjectIds.callCount).to.equal(1);
          chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([ doc]);
          chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
          chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['patient'], false]);
          chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMutingHistory.args[0]).to.deep.equal([ doc, NaN, false]);
        });
      });

      it('should throw updateRegistrations errors', () => {
        const doc = {
          _id: 'id',
          type: 'person',
          patient_id: 'patient',
          muting_history: {
            last_update: 'offline',
          }
        };
        mutingUtils.updateRegistrations.rejects({ some: 'error' });
        utils.getSubjectIds.returns(['id', 'patient']);
        mutingUtils.updateMutingHistory.resolves();
        mutingUtils.isMutedInLineage.returns(true);

        return transition
          .onMatch({ doc })
          .then(() => chai.expect(true).to.equal('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.updateContact.callCount).to.equal(0);
            chai.expect(utils.getSubjectIds.callCount).to.equal(1);
            chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([doc]);
            chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
            chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['id', 'patient'], false]);
            chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(0);
          });
      });

      it('should throw updateMutingHistory errors', () => {
        const doc = {
          _id: 'id',
          type: 'person',
          patient_id: 'patient',
          muting_history: {
            last_update: 'offline',
          }
        };
        const info = { initial_replication_date: 'unknown' };
        mutingUtils.updateRegistrations.resolves();
        utils.getSubjectIds.returns(['id', 'patient']);
        mutingUtils.updateMutingHistory.rejects({ some: 'error' });
        mutingUtils.isMutedInLineage.returns(true);

        return transition
          .onMatch({ doc, info })
          .then(() => chai.expect(true).to.equal('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.updateContact.callCount).to.equal(0);
            chai.expect(utils.getSubjectIds.callCount).to.equal(1);
            chai.expect(utils.getSubjectIds.args[0]).to.deep.equal([doc]);
            chai.expect(mutingUtils.updateRegistrations.callCount).to.equal(1);
            chai.expect(mutingUtils.updateRegistrations.args[0]).to.deep.equal([['id', 'patient'], false]);
            chai.expect(mutingUtils.updateMutingHistory.callCount).to.equal(1);
            chai.expect(mutingUtils.updateMutingHistory.args[0]).to.deep.equal([doc, NaN, false]);
          });
      });
    });

    describe('muting/unmuting', () => {
      const mutingConfig = {
        mute_forms: ['mute'],
        unmute_forms: ['unmute'],
        messages: [
          {
            event_type: 'contact_not_found',
            recipient: 'reporting_unit',
            message: [{
              locale: 'en',
              content: 'Contact was not found'
            }]
          }, {
            event_type: 'already_muted',
            recipient: 'reporting_unit',
            message: [{
              locale: 'en',
              content: 'Contact already muted'
            }]
          }, {
            event_type: 'already_unmuted',
            recipient: 'reporting_unit',
            message: [{
              locale: 'en',
              content: 'Contact already unmuted'
            }]
          }, {
            event_type: 'mute',
            recipient: 'reporting_unit',
            message: [{
              locale: 'en',
              content: 'Muting successful'
            }]
          }, {
            event_type: 'unmute',
            recipient: 'reporting_unit',
            message: [{
              locale: 'en',
              content: 'Unmuting successful'
            }]
          }
        ]
      };

      it('should load the contact', () => {
        const doc = { _id: 'report', type: 'data_record', patient_id: 'patient' };
        const contact = { _id: 'contact', patient_id: 'patient' };
        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);

        return transition.onMatch({ doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(0);
        });
      });

      it('should add an error when contact is not found', () => {
        const doc = { _id: 'report', type: 'data_record' };
        mutingUtils.getContact.returns();
        config.get.returns(mutingConfig);

        return transition.onMatch({ doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
          chai.expect(doc.errors.length).to.equal(1);
          chai.expect(doc.errors[0].message).to.equal('Contact was not found');
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(0);
        });
      });

      it('should add message if contact is already unmuted', () => {
        const doc = { _id: 'report', type: 'data_record', form: 'unmute' };
        const contact = { _id: 'contact' };
        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);

        return transition.onMatch({ doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(0);
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].message).to.equal('Contact already unmuted');
        });
      });

      it('should add message if contact is already muted', () => {
        const contact = { _id: 'contact', muted: 12345 };
        const doc = { _id: 'report', type: 'data_record', form: 'mute', patient: contact };
        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);

        return transition.onMatch({ doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(0);
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].message).to.equal('Contact already muted');
        });
      });

      it('should perform action if last_update was offline, even when contact is in correct state', () => {
        const contact = { _id: 'contact', muted: 12345, muting_history: { last_update: 'offline' } };
        const doc = { _id: 'report', type: 'data_record', form: 'mute', patient: contact };
        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves([]);

        return transition.onMatch({ id: doc._id, doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ contact, true, 'report', undefined ]);
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].message).to.equal('Muting successful');
        });
      });

      it('should add message when muting', () => {
        const contact = { _id: 'contact' };
        const doc = { _id: 'report', type: 'data_record', form: 'mute', place: contact };

        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves([]);

        return transition.onMatch({ id: 'report_id', doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ contact, true, 'report_id', undefined ]);
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].message).to.equal('Muting successful');
        });
      });

      it('should add message when unmuting', () => {
        const contact = { _id: 'contact', muted: 1234 };
        const doc = { _id: 'report', type: 'data_record', form: 'unmute', patient: contact};

        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves([]);

        return transition.onMatch({ id: 'report_id', doc }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ contact, false, 'report_id', undefined ]);
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].message).to.equal('Unmuting successful');
        });
      });

      it('should throw updateMuteState errors', () => {
        const contact = { _id: 'contact', muted: 1234 };
        const doc = { _id: 'report', type: 'data_record', form: 'unmute', patient: contact };

        mutingUtils.getContact.returns(contact);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.rejects({ some: 'error' });

        return transition
          .onMatch({ doc, id: doc._id })
          .then(() => chai.expect(true).to.equal('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.getContact.callCount).to.equal(1);
            chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
            chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
            chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ contact, false, 'report', undefined ]);
            chai.expect(doc.tasks).to.equal(undefined);
            chai.expect(doc.errors).to.equal(undefined);
          });
      });

      it('should skip processing offline muting queue when report not processed offline', () => {
        const doc = {
          _id: 'report',
          type: 'data_record',
          form: 'mute',
          patient: { _id: 'patient', name: 'mary' },
          offline_transitions: {
            notMuting: true,
            alsoNotMuting: true,
          },
        };

        mutingUtils.getContact.returns(doc.patient);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves(['a', 'b', 'c']); // suppose this is broken and gives us report ids
        const runTransitionSpy = sinon.spy(transition, 'onMatch');

        return transition
          .onMatch({ doc, id: doc._id })
          .then(result => {
            chai.expect(result).to.equal(true);
            chai.expect(mutingUtils.getContact.callCount).to.equal(1);
            chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
            chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
            chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ doc.patient, true, 'report', undefined ]);
            chai.expect(doc.errors).to.equal(undefined);
            chai.expect(runTransitionSpy.callCount).to.equal(1);
          });
      });

      it('should do nothing when offline muting queue is empty', () => {
        const doc = {
          _id: 'report',
          type: 'data_record',
          form: 'mute',
          patient: { _id: 'patient', name: 'mary' },
          offline_transitions: {
            notMuting: true,
            alsoNotMuting: true,
            muting: true,
          },
        };

        mutingUtils.getContact.returns(doc.patient);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves([]);
        const runTransitionSpy = sinon.spy(transition, 'onMatch');

        return transition
          .onMatch({ doc, id: doc._id })
          .then(result => {
            chai.expect(result).to.equal(true);
            chai.expect(mutingUtils.getContact.callCount).to.equal(1);
            chai.expect(mutingUtils.getContact.args[0]).to.deep.equal([ doc ]);
            chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
            chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ doc.patient, true, 'report', true ]);
            chai.expect(doc.errors).to.equal(undefined);
            chai.expect(runTransitionSpy.callCount).to.equal(1);
          });
      });

      it('should process offline muting queue when report was processed offline', () => {
        const doc = {
          _id: 'report',
          type: 'data_record',
          form: 'mute',
          patient: { _id: 'patient', name: 'mary' },
          offline_transitions: {
            notMuting: true,
            alsoNotMuting: true,
            muting: true,
          },
        };

        mutingUtils.getContact.returns(doc.patient);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves(['a', 'b', 'c', 'd', 'e', 'f']);
        sinon.stub(mutingUtils.db.medic, 'allDocs').resolves({
          rows: [
            { id: 'a', doc: { _id: 'a', some: 'data', form: 'mute', type: 'data_record' } },
            { id: 'b', error: 'deleted' },
            { id: 'c', doc: { _id: 'c', irrelevant: true } },
            { id: 'd', doc: { _id: 'c', form: 'not-mute', type: 'data_record' } },
            { id: 'd', doc: { _id: 'd', form: 'unmute', type: 'data_record' } },
          ],
        });
        sinon.stub(utils, 'isValidSubmission').returns(true);
        sinon.stub(mutingUtils.lineage, 'hydrateDocs').resolvesArg(0);
        sinon.stub(mutingUtils.infodoc, 'bulkGet')
          .callsFake(changes => Promise.resolve(changes.map(change => ({ doc_id: change.id }))));
        sinon.stub(mutingUtils.infodoc, 'updateTransition').resolves();

        const onMatch = transition.onMatch;
        sinon.stub(transition, 'onMatch').resolves(true);

        return onMatch({ doc, id: doc._id }).then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMuteState.args[0]).to.deep.equal([ doc.patient, true, doc._id, true ]);
          chai.expect(mutingUtils.db.medic.allDocs.callCount).to.equal(1);
          chai.expect(mutingUtils.db.medic.allDocs.args[0]).to.deep.equal([ {
            keys: ['a', 'b', 'c', 'd', 'e', 'f'],
            include_docs: true,
          } ]);
          chai.expect(mutingUtils.lineage.hydrateDocs.callCount).to.equal(1);
          chai.expect(mutingUtils.lineage.hydrateDocs.args[0]).to.deep.equal([[
            { _id: 'a', some: 'data', form: 'mute', type: 'data_record' },
            { _id: 'd', form: 'unmute', type: 'data_record' },
          ]]);
          chai.expect(mutingUtils.infodoc.bulkGet.callCount).to.equal(1);
          chai.expect(mutingUtils.infodoc.bulkGet.args[0]).to.deep.equal([[ { id: 'a' }, { id: 'd' } ]]);
          chai.expect(transition.onMatch.callCount).to.equal(2);
          chai.expect(transition.onMatch.args).to.deep.equal([
            [{ id: 'a', doc: { _id: 'a', some: 'data', form: 'mute', type: 'data_record' }, info: { doc_id: 'a' } }],
            [{ id: 'd', doc: { _id: 'd', form: 'unmute', type: 'data_record' }, info: { doc_id: 'd' } }],
          ]);
          chai.expect(mutingUtils.infodoc.updateTransition.callCount).to.equal(2);
          chai.expect(mutingUtils.infodoc.updateTransition.args).to.deep.equal([
            [
              { id: 'a', doc: { _id: 'a', some: 'data', form: 'mute', type: 'data_record' }, info: { doc_id: 'a' } },
              'muting',
              true,
            ],
            [
              { id: 'd', doc: { _id: 'd', form: 'unmute', type: 'data_record' }, info: { doc_id: 'd' } },
              'muting',
              true,
            ],
          ]);
        });
      });

      it('should throw allDocs errors when processing muting queue', () => {
        const doc = {
          _id: 'report',
          type: 'data_record',
          form: 'mute',
          patient: { _id: 'patient', name: 'mary' },
          offline_transitions: {
            notMuting: true,
            alsoNotMuting: true,
            muting: true,
          },
        };

        mutingUtils.getContact.returns(doc.patient);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves(['a', 'b', 'c', 'd', 'e', 'f']);
        sinon.stub(mutingUtils.db.medic, 'allDocs').rejects({ some: 'error' });
        sinon.stub(utils, 'isValidSubmission');
        sinon.stub(mutingUtils.lineage, 'hydrateDocs');
        sinon.stub(mutingUtils.infodoc, 'bulkGet');
        sinon.stub(mutingUtils.infodoc, 'updateTransition');

        const runTransitionSpy = sinon.spy(transition, 'onMatch');
        return transition
          .onMatch({ id: doc._id, doc })
          .then(() => chai.assert.fail('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.db.medic.allDocs.callCount).to.equal(1);
            chai.expect(mutingUtils.lineage.hydrateDocs.callCount).to.equal(0);
            chai.expect(mutingUtils.infodoc.bulkGet.callCount).to.equal(0);
            chai.expect(runTransitionSpy.callCount).to.equal(1);
          });
      });

      it('should throw lineage errors when processing muting queue', () => {
        const doc = {
          _id: 'report',
          type: 'data_record',
          form: 'mute',
          patient: { _id: 'patient', name: 'mary' },
          offline_transitions: {
            notMuting: true,
            alsoNotMuting: true,
            muting: true,
          },
        };

        mutingUtils.getContact.returns(doc.patient);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves(['a', 'b', 'c', 'd', 'e', 'f']);
        sinon.stub(mutingUtils.db.medic, 'allDocs').resolves({ rows: [
          { id: 'a', doc: { _id: 'a', type: 'data_record', form: 'mute' } },
        ] });
        sinon.stub(utils, 'isValidSubmission').returns(true);
        sinon.stub(mutingUtils.lineage, 'hydrateDocs').rejects({ some: 'error' });
        sinon.stub(mutingUtils.infodoc, 'bulkGet');
        sinon.stub(mutingUtils.infodoc, 'updateTransition');

        const runTransitionSpy = sinon.spy(transition, 'onMatch');
        return transition
          .onMatch({ id: doc._id, doc })
          .then(() => chai.assert.fail('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.db.medic.allDocs.callCount).to.equal(1);
            chai.expect(mutingUtils.lineage.hydrateDocs.callCount).to.equal(1);
            chai.expect(runTransitionSpy.callCount).to.equal(1);
          });
      });

      it('should throw "onMatch" error when processing muting queue and stop further processing', () => {
        const doc = {
          _id: 'report',
          type: 'data_record',
          form: 'mute',
          patient: { _id: 'patient', name: 'mary' },
          offline_transitions: {
            notMuting: true,
            alsoNotMuting: true,
            muting: true,
          },
        };

        mutingUtils.getContact.returns(doc.patient);
        config.get.returns(mutingConfig);
        mutingUtils.updateMuteState.resolves(['a', 'b', 'c', 'd', 'e', 'f']);
        sinon.stub(mutingUtils.db.medic, 'allDocs').resolves({ rows: [
          { id: 'a', doc: { _id: 'a', type: 'data_record', form: 'mute' } },
          { id: 'b', doc: { _id: 'b', type: 'data_record', form: 'mute' } },
          { id: 'c', doc: { _id: 'c', type: 'data_record', form: 'mute' } },
        ] });
        sinon.stub(utils, 'isValidSubmission').returns(true);
        sinon.stub(mutingUtils.lineage, 'hydrateDocs').resolvesArg(0);
        sinon.stub(mutingUtils.infodoc, 'bulkGet')
          .callsFake(changes => Promise.resolve(changes.map(change => ({ doc_id: change.id }))));
        sinon.stub(mutingUtils.infodoc, 'updateTransition').resolves();

        const onMatch = transition.onMatch;
        sinon.stub(transition, 'onMatch')
          .onCall(0).resolves(true)
          .onCall(1).rejects({ some: 'error' });

        return onMatch({ id: doc._id, doc })
          .then(() => chai.assert.fail('should have thrown'))
          .catch(err => {
            chai.expect(err).to.deep.equal({ some: 'error' });
            chai.expect(mutingUtils.db.medic.allDocs.callCount).to.equal(1);
            chai.expect(mutingUtils.lineage.hydrateDocs.callCount).to.equal(1);
            chai.expect(mutingUtils.infodoc.bulkGet.callCount).to.equal(1);
            chai.expect(transition.onMatch.callCount).to.equal(2);
          });
      });
    });
  });

  describe('validation', () => {
    it('failure adds error and response', () => {
      const doc = {
        type: 'data_record',
        fields: { patient_id: 'x' },
        contact: { phone: 'x' },
        patient: { name: 'x' },
      };

      mutingUtils.getContact.returns(doc.patient);
      config.get.returns({
        mute_forms: [],
        unmute_forms: [],
        validations: {
          join_responses: false,
          list: [
            {
              property: 'patient_id',
              rule: 'regex("^[0-9]{5}$")',
              message: [
                {
                  content: 'patient id needs 5 numbers.',
                  locale: 'en',
                },
              ],
            },
          ],
        }
      });

      const change = { doc: doc };
      return transition
        .onMatch(change)
        .then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(doc.errors.length).to.equal(1);
          chai.expect(doc.errors[0].message).to.equal('patient id needs 5 numbers.');
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].message).to.equal('patient id needs 5 numbers.');
          chai.expect(doc.tasks[0].messages[0].to).to.equal('x');
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(0);
        });
    });

    it('success should continue execution', () => {
      const doc = {
        type: 'data_record',
        form: 'mute',
        fields: { patient_id: '12345' },
        contact: { phone: 'x' },
      };
      const contact = { _id: 'contact' };

      config.get.returns({
        mute_forms: ['mute'],
        unmute_forms: [],
        validations: {
          join_responses: false,
          list: [
            {
              property: 'patient_id',
              rule: 'regex("^[0-9]{5}$")',
              message: [
                {
                  content: 'patient id needs 5 numbers.',
                  locale: 'en',
                },
              ],
            },
          ],
        },
        messages: [
          {
            event_type: 'mute',
            recipient: 'reporting_unit',
            message: [{
              locale: 'en',
              content: 'Muting successful'
            }]
          }
        ]
      });
      mutingUtils.getContact.resolves(contact);
      mutingUtils.updateMuteState.resolves(true);

      return transition
        .onMatch({ doc })
        .then(result => {
          chai.expect(result).to.equal(true);
          chai.expect(doc.errors).to.equal(undefined);
          chai.expect(mutingUtils.getContact.callCount).to.equal(1);
          chai.expect(mutingUtils.updateMuteState.callCount).to.equal(1);
          chai.expect(doc.tasks.length).to.equal(1);
          chai.expect(doc.tasks[0].messages[0].to).to.equal('x');
          chai.expect(doc.tasks[0].messages[0].message).to.equal('Muting successful');
        });
    });
  });
});
