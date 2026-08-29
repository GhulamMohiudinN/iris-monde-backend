const httpStatus = require("http-status");
const catchAsync = require("../../utils/catchAsync");
const svc        = require("./service");

const chat = catchAsync(async (req, res) => {
  const result = await svc.chatWithAssistant({ contents: req.body.contents });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

module.exports = { chat };
