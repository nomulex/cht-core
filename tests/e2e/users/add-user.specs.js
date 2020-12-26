const utils=require('../../utils');
const usersPage=require('../../page-objects/users/users.po.js');
const helper=require('../../helper');
const addUserModal=require('../../page-objects/users/add-user-modal.po.js');
const { browser }=require('protractor');
const addedUser='fulltester';
const fullName='Full Tester';


describe('Add user  : ', () => {
  let originalTimeout;

  beforeEach(function() {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;//travis slow
  });

  afterEach(function() {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });
  afterAll(done =>
    utils.request(`/_users/${addedUser}`)
      .then(doc => utils.request({
        path: `/_users/${addedUser}?rev=${doc._rev}`,
        method: 'DELETE'
      }))
      .catch(() => { }) // If this fails we don't care
      .then(() => utils.afterEach(done)));

  it('should add user with valid password', () => {
    helper.waitForAppToLoad();
    browser.get(utils.getAdminBaseUrl() + 'users');
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm(addedUser, fullName, 'StrongP@ssword1');
    addUserModal.submit();
    addUserModal.waitForFormToDisappear();
    helper.waitUntilReady(usersPage.getUsersList());
    usersPage.waitPageToLoad();
    usersPage.expectUser(addedUser, fullName);
  });

  it('should reject passwords shorter than 8 characters', () => {
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm('user0', 'Not Saved', 'short');
    addUserModal.submit();
    addUserModal.expectErrorMessagePassword('The password must be at least 8 characters long.');
    addUserModal.cancel();
  });

  it('should reject weak passwords', () => {
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm('user0', 'Not Saved', 'weakPassword');
    addUserModal.submit();
    addUserModal.expectErrorMessagePassword('The password is too easy to guess.');
    addUserModal.cancel();
  });

  it('should reject non-matching passwords', () => {
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm('user0', 'Not Saved', '%4wbbygxkgdwvdwT65', 'otherpass');
    addUserModal.submit();
    addUserModal.expectErrorMessagePassword('Passwords must match');
    addUserModal.cancel();
  });

  it('should require password', () => {
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm('user0', 'Not Saved', '');
    addUserModal.submit();
    addUserModal.expectErrorMessagePassword('required');
    addUserModal.cancel();
  });

  it('should require username',  () => {
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm('', 'Not Saved', '%4wbbygxkgdwvdwT65');
    addUserModal.submit();
    addUserModal.expectErrorMessageUserName('required');
    addUserModal.cancel();
  });

  it('should require place and contact for restricted user', () => {
    usersPage.openAddUserModal();
    addUserModal.waitForTranslation();
    addUserModal.fillForm('restricted', 'Not Saved', '%4wbbygxkgdwvdwT65');
    helper.selectDropdownByValue(element(by.id('role')), 'string:district_admin');
    addUserModal.submit();
    addUserModal.requireFacility();
    addUserModal.requireContact();
    addUserModal.cancel();
  });
});
