const { isWorkspaceAdmin } = require("../../middlewares/auth");
const httpStatus = require("http-status");
const ApiError = require("../../utils/ApiError");
const { Step } = require("./model");
const { Process } = require("../process/model");
const {
  AUDIT_ACTIONS,
  buildAuditChanges,
  addProcessAudit,
} = require("../process/audit");
const notificationService = require("../notification/service");

/**
 * Tells each assignee about the steps just given to them — one notification
 * per person, however many steps, so assigning a whole process does not bury
 * someone in a notification per step. Never fails the save that triggered it.
 */
const notifyStepAssignees = async ({ workspaceId, steps, processId, processName, actor }) => {
  try {
    const byAssignee = new Map();
    for (const step of steps || []) {
      if (!step?.assignee) continue;
      const key = String(step.assignee._id || step.assignee);
      byAssignee.set(key, [...(byAssignee.get(key) || []), step]);
    }
    for (const [userId, assigned] of byAssignee) {
      await notificationService.notifyUsers({
        workspaceId,
        userIds:       [userId],
        excludeUserId: actor?._id,
        type:          "step_assigned",
        title:         assigned.length === 1
          ? `Step assigned to you: ${assigned[0].title}`
          : `${assigned.length} steps assigned to you`,
        message:       `In "${processName || "a process"}"${actor?.name ? `, from ${actor.name}` : ""}`,
        link:          `/processes/${processId}`,
      });
    }
  } catch (err) {
    console.error("[step] assignment notification failed:", err.message);
  }
};

const createStepForProcess = async ({ workspaceId, payload, actor }) => {
  const process = await Process.findOne({
    _id: payload.processId,
    workspaceId,
  }).select("name");
  if (!process) {
    throw new ApiError(httpStatus.NOT_FOUND, "Process not found");
  }

  const step = await Step.create({
    workspaceId,
    processId: payload.processId,
    title: payload.title,
    description: payload.description || "",
    timeEstimate: payload.timeEstimate || "",
    assignee: payload.assignee || null,
    notes: payload.notes || "",
    status: payload.status || "draft",
    coordinates: payload.coordinates || { x: null, y: null },
    sequenceNo: payload.sequenceNo,
  });

  await addProcessAudit({
    processId: process._id,
    action: AUDIT_ACTIONS.CREATE_STEP,
    actor,
    entityType: "step",
    entityId: step._id,
    message: `Step ${step.title} created for process ${process.name}`,
    changes: [
      { field: "title", oldValue: null, newValue: step.title },
      { field: "status", oldValue: null, newValue: step.status },
    ],
  });

  await notifyStepAssignees({
    workspaceId, steps: [step], processId: process._id, processName: process.name, actor,
  });

  return Step.findById(step._id).populate(
    "assignee",
    "name email role userType",
  );
};

const createStepsForProcess = async ({
  workspaceId,
  processId,
  steps = [],
  actor,
  processName,
}) => {
  const stepsPayload = steps.map((step) => ({
    workspaceId,
    processId,
    title: step.title,
    description: step.description || "",
    timeEstimate: step.timeEstimate || "",
    assignee: step.assignee || null,
    notes: step.notes || "",
    status: step.status || "draft",
    coordinates: step.coordinates || { x: null, y: null },
    sequenceNo: step.sequenceNo,
  }));

  const createdSteps = stepsPayload.length
    ? await Step.insertMany(stepsPayload)
    : [];

  if (createdSteps.length) {
    await addProcessAudit({
      processId,
      action: AUDIT_ACTIONS.CREATE_STEP,
      actor,
      entityType: "step",
      entityId: createdSteps[0]._id,
      message: `${createdSteps.length} step(s) created for process ${processName}`,
      changes: [
        { field: "stepsCount", oldValue: 0, newValue: createdSteps.length },
      ],
    });
  }

  await notifyStepAssignees({ workspaceId, steps: createdSteps, processId, processName, actor });

  return createdSteps;
};

const updateStepById = async ({ stepId, workspaceId, payload, actor }) => {
  const step = await Step.findOne({ _id: stepId, workspaceId });
  if (!step) {
    throw new ApiError(httpStatus.NOT_FOUND, "Step not found");
  }

  const before = {
    title: step.title,
    description: step.description,
    timeEstimate: step.timeEstimate,
    assignee: step.assignee ? String(step.assignee) : null,
    notes: step.notes,
    status: step.status,
    coordinates: step.coordinates,
    sequenceNo: step.sequenceNo,
  };

  if (payload.title !== undefined) step.title = payload.title;
  if (payload.description !== undefined) step.description = payload.description;
  if (payload.timeEstimate !== undefined)
    step.timeEstimate = payload.timeEstimate;
  if (payload.assignee !== undefined) step.assignee = payload.assignee || null;
  if (payload.notes !== undefined) step.notes = payload.notes;
  if (payload.status !== undefined) step.status = payload.status;
  if (payload.coordinates !== undefined) step.coordinates = payload.coordinates;
  if (payload.sequenceNo !== undefined) step.sequenceNo = payload.sequenceNo;

  await step.save();

  const after = {
    title: step.title,
    description: step.description,
    timeEstimate: step.timeEstimate,
    assignee: step.assignee ? String(step.assignee) : null,
    notes: step.notes,
    status: step.status,
    coordinates: step.coordinates,
    sequenceNo: step.sequenceNo,
  };

  const changes = buildAuditChanges(before, after, [
    "title",
    "description",
    "timeEstimate",
    "assignee",
    "notes",
    "status",
    "coordinates",
    "sequenceNo",
  ]);

  if (changes.length) {
    await addProcessAudit({
      processId: step.processId,
      action: AUDIT_ACTIONS.UPDATE_STEP,
      actor,
      entityType: "step",
      entityId: step._id,
      message: `Step ${step.title} updated`,
      changes,
    });
  }

  if (after.assignee && after.assignee !== before.assignee) {
    const process = await Process.findOne({ _id: step.processId, workspaceId }).select("name").lean();
    await notifyStepAssignees({
      workspaceId, steps: [step], processId: step.processId, processName: process?.name, actor,
    });
  }

  return Step.findById(step._id).populate(
    "assignee",
    "name email role userType",
  );
};

const deleteStepById = async ({ stepId, workspaceId, actor }) => {
  const step = await Step.findOne({ _id: stepId, workspaceId });
  if (!step) {
    throw new ApiError(httpStatus.NOT_FOUND, "Step not found");
  }

  await addProcessAudit({
    processId: step.processId,
    action: AUDIT_ACTIONS.DELETE_STEP,
    actor,
    entityType: "step",
    entityId: step._id,
    message: `Step ${step.title} deleted`,
    changes: [{ field: "deleted", oldValue: false, newValue: true }],
  });

  await Step.deleteOne({ _id: step._id });
  return { id: step._id, processId: step.processId };
};

const deleteStepsByProcessId = async ({ processId, workspaceId }) => {
  await Step.deleteMany({ processId, workspaceId });
};

const getStepsByProcessIds = async ({ processIds, workspaceId }) => {
  return Step.find({ processId: { $in: processIds }, workspaceId })
    .sort({ createdAt: 1 })
    .populate("assignee", "name email role userType")
    .lean();
};

const getStepsByProcessId = async ({ processId, workspaceId }) => {
  return Step.find({ processId, workspaceId })
    .sort({ createdAt: 1 })
    .populate("assignee", "name email role userType")
    .lean();
};

const completeStepById = async ({ stepId, workspaceId, actor }) => {
  const step = await Step.findOne({ _id: stepId, workspaceId });
  if (!step) {
    throw new ApiError(httpStatus.NOT_FOUND, "Step not found");
  }

  // Check if user is assignee or admin
  const isAssignee =
    step.assignee && String(step.assignee) === String(actor._id);
  // Any workspace admin, including a member invited as Admin. This used to
  // check userType only, so an invited admin could not complete steps.
  const isAdmin = isWorkspaceAdmin(actor);

  if (!isAssignee && !isAdmin) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      "You do not have permission to complete this step",
    );
  }

  // Check if step is already completed
  if (step.status === "completed") {
    throw new ApiError(httpStatus.BAD_REQUEST, "Step is already completed");
  }

  const before = {
    status: step.status,
  };

  step.status = "completed";
  await step.save();

  const after = {
    status: step.status,
  };

  const changes = buildAuditChanges(before, after, ["status"]);

  if (changes.length) {
    await addProcessAudit({
      processId: step.processId,
      action: AUDIT_ACTIONS.UPDATE_STEP,
      actor,
      entityType: "step",
      entityId: step._id,
      message: `Step ${step.title} completed`,
      changes,
    });
  }

  return Step.findById(step._id).populate(
    "assignee",
    "name email role userType",
  );
};

module.exports = {
  createStepForProcess,
  createStepsForProcess,
  updateStepById,
  deleteStepById,
  deleteStepsByProcessId,
  getStepsByProcessIds,
  getStepsByProcessId,
  completeStepById,
  countStepsByWorkspaceId: (workspaceId) =>
    Step.countDocuments({ workspaceId }),
};
