const Joi = require('joi');

const createCompanySchema = Joi.object({
  companyName: Joi.string().trim().min(2).max(120).required().messages({
    'string.empty': 'Company name is required',
    'string.min': 'Company name must be at least 2 characters',
  }),
  adminName: Joi.string().trim().min(2).max(120).required().messages({
    'string.empty': "The administrator's name is required",
  }),
  adminEmail: Joi.string().trim().lowercase().email().required().messages({
    'string.empty': "The administrator's email is required",
    'string.email': 'Enter a valid email address',
  }),
  companyEmail: Joi.string().trim().lowercase().email().allow('', null),
  industry: Joi.string().trim().max(120).allow('', null),
  headquarters: Joi.string().trim().max(160).allow('', null),
  currency: Joi.string().trim().max(10).allow('', null),
});

const validateCreateCompany = (body) =>
  createCompanySchema.validate(body, { abortEarly: false, stripUnknown: true });

module.exports = { validateCreateCompany };
