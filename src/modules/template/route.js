const express = require('express');
const auth = require('../../middlewares/auth');
const { isSuperAdmin, requireRole } = require('../../middlewares/auth');
const templateController = require('./controller');

const router = express.Router();

router
    .post('/create', auth(), requireRole('admin', 'editor'), templateController.createTemplate)
    .patch('/update/:templateId', auth(), requireRole('admin', 'editor'), templateController.updateTemplate)
    .delete('/delete/:templateId', auth(), isSuperAdmin(), templateController.deleteTemplate)
    .get('/list', auth(), templateController.listTemplates)
    .get('/:templateId', auth(), templateController.getTemplateById);

module.exports = router;
