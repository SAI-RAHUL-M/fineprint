// Prints how the sample lease splits into clauses. Run: npm run split:demo [path]
import { readFileSync } from "node:fs";
import { splitClauses } from "../src/lib/split";

const path = process.argv[2] ?? "samples/sketchy-lease.txt";
const clauses = splitClauses(readFileSync(path, "utf8"));
console.table(clauses.map((c) => ({ id: c.id, number: c.number, heading: c.heading, chars: c.text.length })));
