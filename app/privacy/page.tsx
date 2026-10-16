// Public privacy policy and SMS terms, linked from the lead form and used for SMS (TCR) registration.
export const dynamic = "force-dynamic";

export default function Privacy() {
  const company = process.env.ORG_NAME || "Our company";
  const contact = process.env.PRIVACY_CONTACT_EMAIL;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px 60px", lineHeight: 1.6 }}>
      <h1>Privacy Policy and SMS Terms</h1>
      <p className="muted">{company}</p>

      <h2>What we collect</h2>
      <p>When you apply for a driving job, we collect the details you give us: your name, phone number, email, location, and answers about your driving experience. If you choose to upload your CDL, we store that image securely for recruiting review.</p>

      <h2>How we use it</h2>
      <p>We use your information only to contact you about truck driving jobs you applied for, to answer your questions, and to connect you with a recruiter. We may contact you by phone call and text message, including calls made with an automated system or an AI voice assistant working with our recruiters.</p>

      <h2>Sharing</h2>
      <p>We do not sell your information. We share it only with service providers that help us run calls, texts and secure storage, and only for these purposes. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent will not be shared with any third parties.</p>

      <h2>Text messages</h2>
      <p>By giving us your number and agreeing to be contacted, you may receive recruiting text messages from {company}, such as a secure link to upload your CDL. Message frequency varies. Message and data rates may apply. Reply STOP to stop receiving texts, or HELP for help. Consent is not a condition of employment.</p>

      <h2>Stopping contact</h2>
      <p>You can ask us to stop calling on any call, or reply STOP to any text. We will stop automated contact with your number.</p>

      <h2>Storage and deletion</h2>
      <p>Uploaded CDL images are kept only as long as needed for recruiting review and are then deleted. You can ask us to delete your information at any time.</p>

      <h2>Contact</h2>
      <p>{contact ? <>Questions or deletion requests: <a href={`mailto:${contact}`}>{contact}</a>.</> : "For questions or deletion requests, reply to any of our texts or ask the recruiter who contacted you."}</p>
    </main>
  );
}
