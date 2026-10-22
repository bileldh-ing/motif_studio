import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="brand">
      <span className="orb" aria-hidden />
      <span>
        <b>MOTIF</b>
        <small>Video Studio</small>
      </span>
    </Link>
  );
}
