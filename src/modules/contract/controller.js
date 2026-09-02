const httpStatus = require("http-status");
const catchAsync = require("../../utils/catchAsync");
const svc = require("./service");

const workspaceId = (req) => req.user?.workspaceId || req.user?.workspace?._id;

// ── Authenticated ─────────────────────────────────────────────────────────────
const createContract = catchAsync(async (req, res) => {
  const contract = await svc.createContract({ workspaceId: workspaceId(req), payload: req.body, actor: req.user });
  res.status(httpStatus.CREATED).json({ success: true, contract });
});

const listContracts = catchAsync(async (req, res) => {
  const contracts = await svc.listContracts({ workspaceId: workspaceId(req) });
  res.status(httpStatus.OK).json({ success: true, contracts });
});

const getContract = catchAsync(async (req, res) => {
  const contract = await svc.getContract({ workspaceId: workspaceId(req), contractId: req.params.contractId });
  res.status(httpStatus.OK).json({ success: true, contract });
});

const deleteContract = catchAsync(async (req, res) => {
  const result = await svc.deleteContract({ workspaceId: workspaceId(req), contractId: req.params.contractId, actor: req.user });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

// ── Public (no auth — the token is the authorization) ────────────────────────
const getPublicContract = catchAsync(async (req, res) => {
  const contract = await svc.getPublicContract({ token: req.params.token });
  res.status(httpStatus.OK).json({ success: true, contract });
});

const signContract = catchAsync(async (req, res) => {
  const signerIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
  const contract = await svc.signContract({
    token: req.params.token,
    signatureDataUri: req.body.signature,
    signerName: req.body.signerName,
    signerIp,
  });
  res.status(httpStatus.OK).json({ success: true, contract });
});

module.exports = {
  createContract,
  listContracts,
  getContract,
  deleteContract,
  getPublicContract,
  signContract,
};
