import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

if (!accountSid || !authToken || !verifyServiceSid) {
    throw new Error(
        'Missing Twilio environment variables. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID',
    );
}

const twilioClient = twilio(accountSid, authToken);


export async function sendVerificationCode(phoneNumber: string) {
    return twilioClient.verify.v2
        .services(verifyServiceSid!)
        .verifications.create({ to: phoneNumber, channel: 'sms' });
}

export async function checkVerificationCode(phoneNumber: string, code: string) {
    return twilioClient.verify.v2
        .services(verifyServiceSid!)
        .verificationChecks.create({ to: phoneNumber, code })
}


