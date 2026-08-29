const httpStatus = require("http-status");
const catchAsync = require("../../utils/catchAsync");
const svc        = require("./service");

const sendInvoice = catchAsync(async (req, res) => {
  const { to, invoice } = req.body;
  const result = await svc.sendInvoice({ to, invoice, actor: req.user });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

module.exports = { sendInvoice };
