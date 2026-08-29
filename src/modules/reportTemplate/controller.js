const httpStatus = require("http-status");
const catchAsync = require("../../utils/catchAsync");
const svc        = require("./service");

const workspaceId = (req) => req.user?.workspaceId || req.user?.workspace?._id;

const uploadTemplate = catchAsync(async (req, res) => {
  if (!req.file) {
    return res.status(httpStatus.BAD_REQUEST).json({ success: false, message: "No file uploaded" });
  }
  const template = await svc.uploadTemplate({
    workspaceId: workspaceId(req),
    fileBuffer:  req.file.buffer,
    fileName:    req.file.originalname,
    actor:       req.user,
  });
  res.status(httpStatus.CREATED).json({ success: true, template });
});

const listTemplates = catchAsync(async (req, res) => {
  const templates = await svc.listTemplates({ workspaceId: workspaceId(req) });
  res.status(httpStatus.OK).json({ success: true, templates });
});

const deleteTemplate = catchAsync(async (req, res) => {
  const result = await svc.deleteTemplate({ workspaceId: workspaceId(req), templateId: req.params.templateId });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

const generateFromTemplate = catchAsync(async (req, res) => {
  const { obligationIds } = req.body;
  const result = await svc.generateFromTemplate({
    workspaceId:   workspaceId(req),
    templateId:    req.params.templateId,
    obligationIds,
    companyName:   req.workspace?.companyName || "",
  });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

const finalizeXlsx = catchAsync(async (req, res) => {
  const { fileName, sheets } = req.body;
  const { buffer, fileName: outName, mimeType } = svc.finalizeXlsx({ fileName, sheets });

  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${outName.replace(/"/g, "")}"`);
  res.send(buffer);
});

module.exports = { uploadTemplate, listTemplates, deleteTemplate, generateFromTemplate, finalizeXlsx };
