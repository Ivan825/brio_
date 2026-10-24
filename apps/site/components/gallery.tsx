import Image from "next/image";
import { SHOTS } from "@/lib/content";

/** Real screens of the app, the board first and largest; each opens full size. */
export function Gallery() {
  const [first, ...rest] = SHOTS;
  const figure = (s: (typeof SHOTS)[number], big: boolean) => (
    <figure key={s.file} className={`flex flex-col ${big ? "lg:col-span-2 lg:row-span-2" : ""}`}>
      <a
        href={`/shots/${s.file}.jpg`}
        className="block overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-fast hover:border-line-strong"
      >
        <Image
          src={`/shots/${s.file}.jpg`}
          alt={`${s.title}: ${s.caption}`}
          width={1440}
          height={900}
          priority={big}
          className="block h-auto w-full"
        />
      </a>
      <figcaption className="mt-2 text-sm">
        <span className="font-mono text-fg">{s.title}</span>
        <span className="text-fg-muted"> · {s.caption}</span>
      </figcaption>
    </figure>
  );
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {first ? figure(first, true) : null}
      {rest.map((s) => figure(s, false))}
    </div>
  );
}
