import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy · Pagefirst",
  description: "What Pagefirst stores about you and your Google Docs, and how Google user data is used.",
};

const updated = "27 November 2026";

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 leading-relaxed">
      <p>
        <Link href="/" className="underline">
          Pagefirst
        </Link>
      </p>
      <h1 className="mt-6 text-3xl font-semibold">Privacy policy</h1>
      <p className="mt-2 text-sm opacity-70">Last updated {updated}</p>

      <h2 className="mt-8 text-xl font-semibold">What Pagefirst is</h2>
      <p className="mt-2">
        Pagefirst lets you write a web page in a Google Doc, edit it visually, and publish it as a static site. It only touches the Docs you
        create with it or pick for it.
      </p>

      <h2 className="mt-8 text-xl font-semibold">What we access from Google</h2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          <strong>Your name, email address and profile picture</strong> (sign-in scopes) to identify your account.
        </li>
        <li>
          <strong>Google Docs</strong> (<code>documents</code> scope) to read the content of the Docs you open in Pagefirst and to write your
          edits back to them when you commit.
        </li>
        <li>
          <strong>Google Drive files created or picked by Pagefirst</strong> (<code>drive.file</code> scope) to create your site folder and
          Docs, upload images you add, and open existing Docs you choose. Pagefirst cannot see other files in your Drive.
        </li>
      </ul>

      <h2 className="mt-8 text-xl font-semibold">What we store</h2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Your Google account id and email address.</li>
        <li>Your Google refresh and access tokens, encrypted at rest, so that Pagefirst can act for you until you sign out or revoke access.</li>
        <li>Session records and an audit log of actions (who did what to which Doc, when). The log does not contain the text of your Docs.</li>
        <li>The pages you publish. A published page is public at its address, and is stored with the rest of your site&apos;s files.</li>
        <li>Organization membership, role and plan, if you use organizations.</li>
      </ul>
      <p className="mt-2">We do not copy the content of your Docs into our database. We read it when you ask us to and discard it afterwards.</p>

      <h2 className="mt-8 text-xl font-semibold">How we use Google user data</h2>
      <p className="mt-2">
        Pagefirst&apos;s use and transfer of information received from Google APIs to any other app adheres to the{" "}
        <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy#limited-use">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. In particular:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>We use Google user data only to provide and improve the features you see in Pagefirst.</li>
        <li>We do not sell Google user data, and we do not use it for advertising, including retargeting or interest-based advertising.</li>
        <li>We do not use it to train generalized AI or machine-learning models.</li>
        <li>No person at Pagefirst reads your Docs, except with your consent for a specific support request, where required for security or to comply with law.</li>
        <li>We share data with service providers only as needed to run Pagefirst (hosting, database and file storage), under their terms.</li>
      </ul>

      <h2 className="mt-8 text-xl font-semibold">Your choices</h2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          Revoke Pagefirst&apos;s access at any time in your{" "}
          <a className="underline" href="https://myaccount.google.com/permissions">
            Google Account permissions
          </a>
          . Pagefirst then can no longer read or write your Docs.
        </li>
        <li>Sign out to end your session. Ask us to delete your account and stored data by opening an issue in the project repository.</li>
        <li>Unpublish a page to remove it from the public site.</li>
      </ul>

      <h2 className="mt-8 text-xl font-semibold">Security and retention</h2>
      <p className="mt-2">
        Tokens are encrypted, sessions are server-side and can be revoked, and audit entries are kept for about 400 days. See the{" "}
        <a className="underline" href="https://github.com/thegreenbot/pagefirst/blob/main/docs/security/threat-model.md">
          threat model
        </a>{" "}
        for what is protected and how.
      </p>

      <h2 className="mt-8 text-xl font-semibold">Changes and contact</h2>
      <p className="mt-2">
        We will update this page when practices change and change the date above. Questions can be raised as an issue at{" "}
        <a className="underline" href="https://github.com/thegreenbot/pagefirst/issues">
          github.com/thegreenbot/pagefirst
        </a>
        .
      </p>
    </main>
  );
}
