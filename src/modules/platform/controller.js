const httpStatus = require('http-status');
const catchAsync = require('../../utils/catchAsync');
const platformService = require('./service');
const { validateCreateCompany } = require('./validation');

const createCompany = catchAsync(async (req, res) => {
  const { error, value } = validateCreateCompany(req.body);
  if (error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: error.details.map((d) => d.message).join(', '),
    });
  }

  const result = await platformService.createClientCompany({
    owner: req.user,
    payload: value,
  });

  // The company exists either way; only the wording changes, so the operator
  // is never told "sent" when nothing was.
  const message = result.invitationSent
    ? `${result.company.companyName} created. An invitation has been sent to ${result.administrator.email}.`
    : `${result.company.companyName} was created, but the invitation to ${result.administrator.email} could not be sent. Use Resend to try again.`;

  return res.status(httpStatus.CREATED).send({
    isSuccess: true,
    message,
    ...result,
  });
});

const resendInvitation = catchAsync(async (req, res) => {
  const result = await platformService.resendCompanyInvitation({
    owner: req.user,
    companyId: req.params.companyId,
  });

  return res.send({
    isSuccess: true,
    message: `A new invitation has been sent to ${result.email}.`,
    ...result,
  });
});

const listCompanies = catchAsync(async (req, res) => {
  const companies = await platformService.listClientCompanies();
  return res.send({ isSuccess: true, companies });
});

module.exports = { createCompany, resendInvitation, listCompanies };
