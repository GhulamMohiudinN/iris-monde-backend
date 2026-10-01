const express = require('express');
const auth = require('../../middlewares/auth');
const { isPlatformOwner } = require('../../middlewares/auth');
const controller = require('./controller');

const router = express.Router();

// Every route here is platform-operator only. isPlatformOwner does not accept
// workspace admins, so a client administrator cannot reach another company.
const guard = [auth(), isPlatformOwner()];

router
  .post('/companies', ...guard, controller.createCompany)
  .get('/companies', ...guard, controller.listCompanies)
  .post('/companies/:companyId/resend-invitation', ...guard, controller.resendInvitation);

module.exports = router;
