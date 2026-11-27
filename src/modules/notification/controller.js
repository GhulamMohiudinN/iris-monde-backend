const httpStatus = require("http-status");
const catchAsync = require("../../utils/catchAsync");
const svc = require("./service");

const list = catchAsync(async (req, res) => {
  const result = await svc.listForUser(req.user._id);
  res.status(httpStatus.OK).json({ success: true, ...result });
});

const unreadCount = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({ success: true, unread: await svc.unreadCount(req.user._id) });
});

const markRead = catchAsync(async (req, res) => {
  const notification = await svc.markRead(req.user._id, req.params.notificationId);
  res.status(httpStatus.OK).json({ success: true, notification });
});

const markAllRead = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({ success: true, ...(await svc.markAllRead(req.user._id)) });
});

module.exports = { list, unreadCount, markRead, markAllRead };
