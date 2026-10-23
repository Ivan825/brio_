import { greeting } from "../lib/greeting.ts";

export default function Home() {
  return (
    <main>
      <h1>{greeting("visitor")}</h1>
      <p>Nobody is signed in yet.</p>
    </main>
  );
}
