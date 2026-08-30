import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "About — SoverStore",
  description:
    "SoverStore makes sovereign file storage understandable, private, and portable.",
};

const principles = [
  {
    number: "01",
    title: "Local by default",
    text: "Your document is encrypted on your device before it touches public infrastructure.",
  },
  {
    number: "02",
    title: "Public, not exposed",
    text: "Bulletin holds verifiable encrypted bytes—not the meaning inside them.",
  },
  {
    number: "03",
    title: "Access that travels",
    text: "A private recovery file or QR keeps access portable and under your control.",
  },
];

export default function AboutPage() {
  return (
    <main className="shell story-page drops-page">
      <Nav />

      <header className="story-hero">
        <div className="story-kicker">Sovereign file storage</div>
        <h1>Public infrastructure does not have to mean public content.</h1>
        <p className="story-lede">
          SoverStore encrypts the document before it leaves your device,
          publishes only protected bytes, and gives you a portable way back.
        </p>
      </header>

      <section className="manifesto" aria-label="SoverStore promise">
        <div className="punch" aria-hidden />
        <p>Encrypt locally.</p>
        <p>Publish publicly.</p>
        <p className="manifesto-accent">Recover privately.</p>
      </section>

      <section className="story-section" aria-labelledby="why-title">
        <div className="story-section-heading">
          <span>Why SoverStore</span>
          <h2 id="why-title">The infrastructure may hold the bytes. You control their meaning.</h2>
        </div>
        <p className="story-copy">
          Private files should not depend on a platform keeping every promise
          forever. SoverStore separates storage from access: decentralized
          infrastructure preserves the encrypted file, while the recovery
          credential stays with you. There is no SoverStore server holding a
          second copy of your document or key—because no such server exists.
        </p>
      </section>

      <section className="principles-grid" aria-label="Core principles">
        {principles.map((principle) => (
          <article className="principle-card" key={principle.number}>
            <span>{principle.number}</span>
            <h2>{principle.title}</h2>
            <p>{principle.text}</p>
          </article>
        ))}
      </section>

      <section className="story-section story-mission" aria-labelledby="mission-title">
        <div className="story-kicker">Our mission</div>
        <h2 id="mission-title">
          Make sovereign storage usable without making people manage protocols,
          encryption formats, CIDs, or blockchain infrastructure by hand.
        </h2>
        <p>
          Store a file. Keep the credential. Recover the original wherever the
          open infrastructure can be reached.
        </p>
      </section>

      <div className="story-actions">
        <Link className="btn btn-pink link-btn" href="/">
          Store a file
        </Link>
        <Link className="text-link" href="/drops">
          Discover Private Drops <span aria-hidden>→</span>
        </Link>
      </div>
    </main>
  );
}
