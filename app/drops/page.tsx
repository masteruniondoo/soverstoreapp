import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Private Drops — SoverStore",
  description:
    "Private Drops are SoverStore's next step toward cryptographically controlled content distribution.",
};

const dropFlow = [
  {
    number: "01",
    title: "Encrypt",
    text: "The publisher protects the content before it leaves their device.",
  },
  {
    number: "02",
    title: "Define",
    text: "Access is tied to transparent, verifiable on-chain conditions.",
  },
  {
    number: "03",
    title: "Drop",
    text: "Eligible users unlock the content without a central access server.",
  },
];

export default function DropsPage() {
  return (
    <main className="shell story-page">
      <Nav />

      <header className="story-hero drops-hero">
        <div className="story-kicker">The next product stage</div>
        <h1>Private content. Programmable access.</h1>
        <p className="story-lede">
          Private Drops will let publishers release encrypted content to people
          who meet clear on-chain conditions—without a central subscriber
          database holding the keys.
        </p>
      </header>

      <section className="drop-ticket" aria-label="Private Drops status">
        <div className="punch" aria-hidden />
        <div className="stamp hollow">In development</div>
        <div className="voucher-eyebrow">SoverStore / Private Drops</div>
        <p className="drop-ticket-title">Publish once. Release by proof.</p>
        <p className="drop-ticket-copy">
          The content stays encrypted on public infrastructure. Access is
          released cryptographically when the condition is met.
        </p>
        <div className="drop-ticket-code">ACCESS ≠ CUSTODY</div>
      </section>

      <section className="story-section drops-intro" aria-labelledby="drops-title">
        <div className="story-section-heading">
          <span>The idea</span>
          <h2 id="drops-title">Distribution without the gatekeeper.</h2>
        </div>
        <p className="story-copy">
          Today, SoverStore proves that a document can be published and
          recovered without surrendering it to a central platform. Private
          Drops extend the same principle to distribution: the publisher
          defines who can unlock an encrypted release, while public
          infrastructure carries the content.
        </p>
      </section>

      <section className="drop-flow" aria-label="Private Drops flow">
        {dropFlow.map((step) => (
          <article key={step.number}>
            <span className="drop-step-number">{step.number}</span>
            <div>
              <h2>{step.title}</h2>
              <p>{step.text}</p>
            </div>
          </article>
        ))}
      </section>

      <section className="drops-note">
        <div className="story-kicker">Built on the same promise</div>
        <p>
          Public infrastructure. Private content. Portable access.
        </p>
        <small>
          Private Drops are a product direction and are not yet available in
          the current Devnet application.
        </small>
      </section>

      <div className="story-actions">
        <Link className="btn btn-pink link-btn" href="/">
          Explore current storage
        </Link>
        <Link className="text-link" href="/about">
          About SoverStore <span aria-hidden>→</span>
        </Link>
      </div>
    </main>
  );
}
