const stores = [
  {
    name: "Google Doc",
    holds: "The canonical page",
    writer: "Commit",
  },
  {
    name: "Editor draft",
    holds: "Uncommitted page structure",
    writer: "Typing, images, layout",
  },
  {
    name: "Cloudflare",
    holds: "Static HTML, CSS, and copied assets",
    writer: "Publish",
  },
];

const pass = [
  {
    n: "01",
    title: "Open",
    body: "The signed-in token reads the Doc. The parser builds the page. Named ranges are the anchors.",
  },
  {
    n: "02",
    title: "Edit",
    body: "Words, images, and block order change the draft. Keystrokes stay in the browser.",
  },
  {
    n: "03",
    title: "Commit",
    body: "Operations become a Docs batchUpdate. A revision that moved returns 409 and writes nothing.",
  },
  {
    n: "04",
    title: "Publish",
    body: "The same renderer runs in publish mode. Images leave Drive. HTML on that URL is purged.",
  },
];

const decisions: [string, string][] = [
  ["Identity", "Google OAuth only. A 403 from Google is the permission check."],
  ["Scopes", "openid, documents, and drive.file. Existing docs come in through the Picker."],
  ["When the Doc changes", "On commit, not on each keystroke."],
  ["Anchors", "Named ranges pg/section, pg/node, and pg/meta. Indexes are never cached."],
  ["Layout", "Reorder, insert, remove, and block options. Palette: prose, hero, columns, cards."],
  ["CDN", "Cloudflare Pages Direct Upload. Local ./out when the token is absent."],
  ["Preview hostname", "The editor is the preview until a second person needs a link."],
  ["Database", "None, until something must publish without a person present."],
  ["Conflicts", "409 and reload. No merge in the first version."],
  ["Stack", "Next.js and TypeScript."],
];

const contract: [string, string, string][] = [
  ["Section break", "A paragraph whose text is ---", "pg/section/{id}"],
  ["Prose", "Heading, paragraph, list, or image", "pg/node/{id}"],
  ["Block", "A table. First cell is hero or columns (contained)", "pg/node/{id} on the table"],
  ["Page metadata", "A two-column table named metadata. It is kept off the page.", "pg/meta"],
  ["Section style", "A section metadata table at the end of a section", "pg/node/{id}"],
  ["Image bytes", "An inline image after insert. Drive is the upload source.", "Inside the node range"],
];

const ops: [string, string][] = [
  ["replaceText", "Replace the text inside that named range and keep the paragraph style."],
  ["setBlockOptions", "Rewrite the parenthetical in the name cell."],
  ["setMetadata", "Update one row of the metadata table."],
  ["insertBlock / insertSection", "Insert a table or a --- paragraph at the resolved index."],
  ["removeNode", "Delete the content covered by the named range."],
  ["moveNode", "Rebuild the table at the destination, then delete the original. Docs has no move."],
  ["setImage", "Temporary link share, insertInlineImage, then remove the share."],
];

const slices = [
  {
    n: "1",
    title: "Read a Doc into a preview",
    goal: "Sign in with Google, open a Doc, and show it as a page. This slice proves the parser against a real document.",
    pieces: [
      ["Sign-in", "OAuth code with PKCE. Scopes: openid, documents, drive.file."],
      ["Open", "A site folder the app created, or an existing Doc via the Picker."],
      ["Parse", "Prose, --- section breaks, one table block, and the metadata table."],
      ["Render", "A read-only preview. Metadata stays in the page head."],
    ],
    done: "The About fixture renders as a title, a hero, and a columns block. A Doc this account cannot edit shows Google's error.",
  },
  {
    n: "2",
    title: "Edit words and commit them",
    goal: "Inline text stays in a draft. Commit writes it through named ranges, then the server re-reads the Doc and the editor renders that result.",
    pieces: [
      ["Adopt", "The first commit creates named ranges and changes no visible text."],
      ["Draft", "Keystrokes edit the page structure in the browser."],
      ["Commit", "replaceText inside the named range. The server re-reads and returns the page."],
      ["Conflict", "If the Doc revision moved, respond 409 and leave the draft unsent."],
    ],
    done: "The new sentence is visible in Google Docs itself. An edit made in Docs between load and commit returns 409 and writes nothing.",
  },
  {
    n: "3",
    title: "Place images and move blocks",
    goal: "Layout is reorder, insert, remove, and block options. The palette is prose, hero, columns, and cards. Image bytes end up stored in the Doc.",
    pieces: [
      ["Upload", "Bytes go to the site media folder. The draft stores the Drive file id."],
      ["Insert", "Brief link-share, insertInlineImage, then remove the share."],
      ["Move", "Rebuild the table at the destination and delete the original range."],
      ["Protect", "A commit that would overlap a comment, drawing, or unknown table is rejected."],
    ],
    done: "Table order in the Doc matches the preview. The image still loads after the share is removed. A pre-existing comment is still on the Doc.",
  },
  {
    n: "4",
    title: "Ship a static snapshot",
    goal: "Publish renders the last committed revision with the same function as the preview, copies images off Drive, and uploads the directory.",
    pieces: [
      ["Gate", "Publish refuses while the draft has uncommitted operations."],
      ["Render", "Publish mode strips contenteditable and draft ids."],
      ["Assets", "Content-addressed image files. HTML points at those."],
      ["Upload", "Cloudflare Pages Direct Upload. Local ./out when the token is absent."],
    ],
    done: "The public URL has no editor and no Google sign-in. Publishing the same revision again does not upload.",
  },
  {
    n: "5",
    title: "A folder of pages",
    goal: "The Drive folder is the site. Home is the doc named index. Shared chrome is a fragment Doc. Redirects are a Sheet.",
    pieces: [
      ["Paths", "Folder-relative path. index serves the site root."],
      ["Fragments", "A fragment block points at another Doc. Publish inlines the resolved render."],
      ["Redirects", "A Sheet named redirects maps an old path to a new one."],
      ["Fan-out", "Editing the header fragment and publishing dependents updates each page."],
    ],
    done: "Two pages share one header. Publishing both after a header edit updates both. A redirects row publishes a redirect.",
  },
];

const risks: [string, string, string][] = [
  [
    "Docs indexes shift on every edit",
    "Resolve named ranges on each commit. Re-read after writing. Never reuse an index.",
    "Slice 2",
  ],
  [
    "drive.file hides files the author expects",
    "The app creates the site folder. Existing docs enter through the Picker. The first screen says so.",
    "Slice 1",
  ],
  [
    "insertInlineImage requires a public URL",
    "Link-share for the insert call only. The Doc stores the bytes. Publish copies them out.",
    "Slice 3",
  ],
  [
    "A commit drops content the parser skipped",
    "Opaque spans reject an overlapping edit. The writer never replaces the body.",
    "Slice 3",
  ],
  [
    "Preview HTML and the public page diverge",
    "One render function, two modes. Diff them with editor attributes removed.",
    "Slice 4",
  ],
  [
    "A dirty draft gets published",
    "Publish loads the revision from Google and refuses uncommitted operations.",
    "Slice 4",
  ],
];

const nav = [
  ["Overview", "#overview"],
  ["Contract", "#contract"],
  ["Slices", "#slices"],
  ["Risks", "#risks"],
];

export default function Home() {
  return (
    <>
      <a
        href="#overview"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20 focus:bg-ink focus:px-3 focus:py-2 focus:text-paper"
      >
        Skip to the plan
      </a>
      <header className="sticky top-0 z-10 border-b border-rule bg-paper/95">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3">
          <a href="#overview" className="shrink-0 font-serif text-lg tracking-tight text-ink">
            Page-first
          </a>
          <nav className="flex gap-4 overflow-x-auto text-sm text-ink-soft">
            {nav.map(([label, href]) => (
              <a key={href} href={href} className="shrink-0 hover:text-ink">
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24">
        <section id="overview" className="scroll-mt-20 border-b border-rule py-14">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-green">
            Implementation plan
          </p>
          <h1 className="mt-3 max-w-3xl font-serif text-5xl leading-[1.05] tracking-tight text-ink sm:text-6xl">
            Edit the page. The Google Doc keeps the words.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft">
            An author changes words, images, and layout on a preview of the
            page. Commit writes those changes into the Doc. Publish renders
            the last committed revision and uploads a static snapshot to
            Cloudflare. Sign-in is Google, and edit rights are whatever
            Google already grants on that Doc.
          </p>

          <div className="mt-12 grid gap-px overflow-hidden border border-rule bg-rule sm:grid-cols-3">
            {stores.map((store) => (
              <article key={store.name} className="bg-paper px-5 py-5">
                <h2 className="font-serif text-2xl tracking-tight">{store.name}</h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{store.holds}</p>
                <p className="mt-4 text-xs font-medium uppercase tracking-[0.14em] text-green">
                  Written by {store.writer}
                </p>
              </article>
            ))}
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-soft">
            The preview is a draft. After every commit the server re-reads
            the Doc, and the editor renders that result.
          </p>
        </section>

        <section className="border-b border-rule py-14" aria-labelledby="pass-heading">
          <h2 id="pass-heading" className="font-serif text-3xl tracking-tight">
            One pass through a page
          </h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {pass.map((step) => (
              <li key={step.n}>
                <p className="font-serif text-sm text-green">{step.n}</p>
                <h3 className="mt-1 font-serif text-xl">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-b border-rule py-14" aria-labelledby="where-heading">
          <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <h2 id="where-heading" className="font-serif text-3xl tracking-tight">
                Where this sits
              </h2>
              <div className="mt-5 space-y-4 text-base leading-relaxed text-ink-soft">
                <p>
                  Edge Delivery Services document authoring is doc-first. The
                  author writes in a Google Doc, preview turns that Doc into
                  HTML, and publish copies the result to the CDN.
                </p>
                <p>
                  DA.live is page-first. Its editor loads HTML from the source
                  API and writes HTML back. Preview and publish happen after
                  that write.
                </p>
                <p>
                  This app uses the page-editing gesture and keeps the Doc as
                  the source. The CDN holds a snapshot of one revision and is
                  never read back into the Doc.
                </p>
              </div>
            </div>
            <figure className="border border-rule bg-paper-2 p-4">
              <figcaption className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">
                Fixture · About
              </figcaption>
              <div className="mt-3 border border-rule bg-paper px-5 py-6">
                <p className="font-serif text-3xl leading-tight">About the studio</p>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  A one-paragraph introduction.
                </p>
                <div className="mt-5 border-t border-rule pt-4">
                  <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-green">
                    hero
                  </p>
                  <p className="mt-2 font-serif text-xl leading-snug">
                    The work, plainly described.
                  </p>
                  <div className="mt-3 flex h-24 items-end border border-dashed border-rule px-3 py-2 text-xs text-ink-soft">
                    Inline image
                  </div>
                </div>
                <div className="mt-5 border-t border-rule pt-4">
                  <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-green">
                    columns (contained)
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                    <p>
                      <span className="block text-ink">Left column</span>
                      <span className="text-ink-soft">First point.</span>
                    </p>
                    <p>
                      <span className="block text-ink">Right column</span>
                      <span className="text-ink-soft">Second point.</span>
                    </p>
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-soft">
                The metadata table (title, description, template) is parsed
                and kept off the preview.
              </p>
            </figure>
          </div>
        </section>

        <section id="contract" className="scroll-mt-20 border-b border-rule py-14">
          <h2 className="font-serif text-3xl tracking-tight">Doc contract</h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">
            Ids live in named ranges, not in the text. Opening the Doc in
            Google shows ordinary headings, paragraphs, and tables. The first
            commit of an untagged Doc creates the ranges and changes no
            visible content.
          </p>
          <DataTable
            caption="How a page node sits in the Doc"
            headers={["Page node", "In the Doc", "Range"]}
            rows={contract}
          />
          <h3 className="mt-12 font-serif text-2xl tracking-tight">Commit operations</h3>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
            The client sends the revision it loaded and a list of operations.
            The server resolves ranges, writes from the highest index
            downward, and re-reads the Doc before responding.
          </p>
          <DataTable
            caption="Operations the editor can commit"
            headers={["Operation", "Doc write"]}
            rows={ops}
          />
          <p className="mt-8 max-w-2xl border-l-2 border-green pl-4 text-sm leading-relaxed text-ink-soft">
            Comments, suggestions, drawings, and unknown tables are opaque
            spans. A commit that would overlap one is rejected. The writer
            never replaces the document body.
          </p>
        </section>

        <section id="slices" className="scroll-mt-20 border-b border-rule py-14">
          <h2 className="font-serif text-3xl tracking-tight">Build order</h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">
            A slice is done when its check passes against a real Google Doc.
            The Docs API is called in that slice, not mocked and deferred.
          </p>
          <ol className="mt-10 space-y-12">
            {slices.map((slice) => (
              <li key={slice.n} className="grid gap-6 lg:grid-cols-[5rem_1fr]">
                <p className="font-serif text-4xl text-green">{slice.n}</p>
                <div>
                  <h3 className="font-serif text-2xl tracking-tight">{slice.title}</h3>
                  <p className="mt-2 max-w-2xl leading-relaxed text-ink-soft">{slice.goal}</p>
                  <dl className="mt-5 divide-y divide-rule border-y border-rule">
                    {slice.pieces.map(([name, detail]) => (
                      <div key={name} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-6">
                        <dt className="text-sm font-medium">{name}</dt>
                        <dd className="text-sm leading-relaxed text-ink-soft">{detail}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 text-sm leading-relaxed">
                    <span className="font-medium text-green">Done when. </span>
                    <span className="text-ink-soft">{slice.done}</span>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="risks" className="scroll-mt-20 py-14">
          <h2 className="font-serif text-3xl tracking-tight">Where this breaks</h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">
            Each of these is checked inside the slice that introduces it.
          </p>
          <DataTable
            caption="Risks and the slice that retires them"
            headers={["Risk", "What we do", "Checked in"]}
            rows={risks}
          />

          <h3 className="mt-12 font-serif text-2xl tracking-tight">Decisions already made</h3>
          <dl className="mt-5 divide-y divide-rule border-y border-rule">
            {decisions.map(([topic, decision]) => (
              <div key={topic} className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-6">
                <dt className="text-sm font-medium">{topic}</dt>
                <dd className="text-sm leading-relaxed text-ink-soft">{decision}</dd>
              </div>
            ))}
          </dl>

          <h3 className="mt-12 font-serif text-2xl tracking-tight">Left for later</h3>
          <ul className="mt-4 max-w-2xl list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-soft">
            <li>Real-time collaboration inside the preview. Two authors use the Google Doc. This editor is one writer plus the revision check.</li>
            <li>Comments, suggestions, arbitrary fonts, drawings, and page breaks.</li>
            <li>Nested blocks. A block inside a block makes the write-back ambiguous.</li>
            <li>Saving the preview DOM and publishing that HTML.</li>
            <li>A second login, or an access list that can disagree with Google.</li>
            <li>Unattended publish, which is the first feature that needs a stored refresh token.</li>
          </ul>
        </section>
      </main>
    </>
  );
}

function DataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: string[][];
}) {
  return (
    <div className="mt-6 overflow-x-auto border border-rule">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-paper-2 text-xs uppercase tracking-[0.12em] text-ink-soft">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="px-4 py-3 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-t border-rule align-top">
              {row.map((cell, index) => (
                <td key={index} className="px-4 py-3 leading-relaxed text-ink-soft first:font-medium first:text-ink">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
