const nodemailer = require('nodemailer');
const config = require('../config/config');
const fs = require("fs");
const path = require("path");


const transport = nodemailer.createTransport(config.email.smtp);

const logoUrl = `${config.Frontend_URL}/logo.png`;

const sendEmail = async (to, subject, text) => {
  const msg = { from: config.email.from, to, subject, text };
  await transport.sendMail(msg);
};

// Renders the shared branded action-email template (used for verification,
// password reset, etc.) — one consistent look instead of plain text.
const renderActionEmail = ({ title, bodyText, buttonLabel, buttonUrl, footerNote }) => {
  const templatePath = path.join(__dirname, "../email_template/actionEmail.html");
  let html = fs.readFileSync(templatePath, "utf8");

  return html
    .replace(/{{logoUrl}}/g, logoUrl)
    .replace(/{{title}}/g, title)
    .replace(/{{bodyText}}/g, bodyText)
    .replace(/{{buttonLabel}}/g, buttonLabel)
    .replace(/{{buttonUrl}}/g, buttonUrl)
    .replace(/{{footerNote}}/g, footerNote)
    .replace(/{{year}}/g, new Date().getFullYear());
};

const sendResetPasswordEmail = async (to, token) => {
  const subject = 'Reset your password — Iris Monde';
  const resetPasswordUrl = `${config.Frontend_URL}/reset-password?token=${token}`;
  const html = renderActionEmail({
    title: "Reset your password",
    bodyText: "We received a request to reset your password. Click the button below to choose a new one.",
    buttonLabel: "Reset Password",
    buttonUrl: resetPasswordUrl,
    footerNote: "If you did not request a password reset, you can safely ignore this email — your password will stay unchanged.",
  });
  await transport.sendMail({ from: config.email.from, to, subject, html });
};


const sendVerificationEmail = async (to, token) => {
  const subject = 'Verify your email — Iris Monde';
  const verificationEmailUrl = `${config.Frontend_URL}/workspaceCreation?token=${token}`;
  const html = renderActionEmail({
    title: "Verify your email",
    bodyText: "Welcome to Iris Monde. Click the button below to verify your email address and set up your workspace.",
    buttonLabel: "Verify Email",
    buttonUrl: verificationEmailUrl,
    footerNote: "If you did not create an account, you can safely ignore this email.",
  });
  await transport.sendMail({ from: config.email.from, to, subject, html });
};


const sendAddMemberInvitation = async ({
  to,
  adminName,
  workspaceName,
  appName = "Iris Monde",
  token,
}) => {
  const templatePath = path.join(__dirname, "../email_template/addMember.html");
  const subject = `Invitation to join ${workspaceName}`;
  let html = fs.readFileSync(templatePath, "utf8");

  const inviteUrl = `${config.Frontend_URL}/addMember?token=${token}`;

  html = html
    .replace(/{{adminName}}/g, adminName)
    .replace(/{{workspaceName}}/g, workspaceName)
    .replace(/{{appName}}/g, appName)
    .replace(/{{inviteUrl}}/g, inviteUrl)
    .replace(/{{logoUrl}}/g, logoUrl)
    .replace(/{{year}}/g, new Date().getFullYear());

  await transport.sendMail({
    from: config.email.from,
    to,
    subject,
    html,
  });
};

module.exports = {
  transport,
  sendEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
  sendAddMemberInvitation
};
