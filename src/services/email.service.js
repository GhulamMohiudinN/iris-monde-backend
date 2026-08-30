const nodemailer = require('nodemailer');
const config = require('../config/config');
const fs = require("fs");
const path = require("path");


const transport = nodemailer.createTransport(config.email.smtp);


const sendEmail = async (to, subject, text) => {
  const msg = { from: config.email.from, to, subject, text };
  await transport.sendMail(msg);
};


const sendResetPasswordEmail = async (to, token) => {
  const subject = 'Reset password';
  // replace this url with the link to the reset password page of your front-end app
  const resetPasswordUrl = `${config.Frontend_URL}/reset-password?token=${token}`;
  const text = `Dear user,
To reset your password, click on this link: ${resetPasswordUrl}
If you did not request any password resets, then ignore this email.`;
  await sendEmail(to, subject, text);
};


const sendVerificationEmail = async (to, token) => {
  const subject = 'Email Verification';
  // replace this url with the link to the email verification page of your front-end app
  const verificationEmailUrl = `${config.Frontend_URL}/workspaceCreation?token=${token}`;
  const text = `Dear user,
To verify your email, click on this link: ${verificationEmailUrl}
If you did not create an account, then ignore this email.`;
  await sendEmail(to, subject, text);
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
