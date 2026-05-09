/**
 * Path resolver for mark predicates.
 *
 * Path syntax — JSONPath-ish, but minimal and predictable:
 *
 *   foo.bar.baz                    object property chain
 *   foo[0]                         array index
 *   foo[id=003002]                 array find-where: first element whose
 *                                  field matches the literal value
 *   foo[label_ids has SENT]        array find-where: first element whose
 *                                  field is an array containing the value
 *
 * Returns the resolved value, or undefined if any segment misses. We
 * deliberately distinguish "missing" from "explicitly undefined": both
 * surface as undefined, but predicates like `exists` / `missing` use
 * a separate `lookup()` that reports presence.
 *
 * Why minimal: the path language is part of the wire format. Every
 * operator we add is a porting burden for cross-language reference impls.
 * Keep it tight.
 */

interface Segment {
  kind: "prop" | "index" | "find" | "findHas";
  key: string;          // property name or array index (as string) or field name in find
  value?: string;       // for find/findHas: the matched value
}

const SEGMENT_RE = /^([^.[\]]+)/;

function parsePath(path: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let first = true;
  while (i < path.length) {
    if (path[i] === ".") { i++; continue; }
    if (path[i] === "[") {
      // [N], [field=value], or [field has value]
      const close = path.indexOf("]", i);
      if (close < 0) throw new Error(`unclosed [ in path: ${path}`);
      const inner = path.slice(i + 1, close);
      i = close + 1;
      const hasMatch = inner.match(/^(\S+)\s+has\s+(.+)$/);
      const eqMatch  = inner.match(/^([^=]+)=(.+)$/);
      if (hasMatch) {
        out.push({ kind: "findHas", key: hasMatch[1]!.trim(), value: hasMatch[2]!.trim() });
      } else if (eqMatch) {
        out.push({ kind: "find", key: eqMatch[1]!.trim(), value: eqMatch[2]!.trim() });
      } else if (/^\d+$/.test(inner)) {
        out.push({ kind: "index", key: inner });
      } else {
        throw new Error(`invalid bracket segment in path: [${inner}]`);
      }
      continue;
    }
    const m = path.slice(i).match(SEGMENT_RE);
    if (!m) throw new Error(`unparseable path segment at ${i}: ${path}`);
    if (!first || m[1] !== "") out.push({ kind: "prop", key: m[1]! });
    i += m[1]!.length;
    first = false;
  }
  return out;
}

/** Walk `value` along `segs`, returning the resolved value or undefined. */
function walk(value: unknown, segs: Segment[]): unknown {
  let cur: any = value;
  for (const s of segs) {
    if (cur == null) return undefined;
    switch (s.kind) {
      case "prop":
        cur = cur[s.key];
        break;
      case "index":
        if (!Array.isArray(cur)) return undefined;
        cur = cur[parseInt(s.key, 10)];
        break;
      case "find":
        if (!Array.isArray(cur)) return undefined;
        cur = cur.find((el: any) => el != null && String(el[s.key]) === String(s.value));
        break;
      case "findHas":
        if (!Array.isArray(cur)) return undefined;
        cur = cur.find((el: any) =>
          el != null && Array.isArray(el[s.key]) && el[s.key].some((v: any) => String(v) === String(s.value)));
        break;
    }
  }
  return cur;
}

/**
 * Resolve a path. Returns the value (which may be `undefined`).
 * Use `lookup()` when you need to distinguish "absent" from "present-but-undefined".
 */
export function resolve(world: unknown, path: string): unknown {
  return walk(world, parsePath(path));
}

/**
 * Resolve a path and report presence. `present: false` means the path was
 * not reachable in the tree. `present: true` includes the case where the
 * resolved value is explicitly `null` or `undefined`.
 *
 * Implementation: walk to the parent, then check key presence on the
 * final segment.
 */
export function lookup(world: unknown, path: string): { present: boolean; value: unknown } {
  const segs = parsePath(path);
  if (segs.length === 0) return { present: world !== undefined, value: world };
  const parent = walk(world, segs.slice(0, -1));
  const last = segs[segs.length - 1]!;
  if (parent == null) return { present: false, value: undefined };
  switch (last.kind) {
    case "prop":
      return { present: Object.prototype.hasOwnProperty.call(parent, last.key), value: (parent as any)[last.key] };
    case "index": {
      if (!Array.isArray(parent)) return { present: false, value: undefined };
      const idx = parseInt(last.key, 10);
      return { present: idx < parent.length, value: parent[idx] };
    }
    case "find":
    case "findHas": {
      const v = walk(world, segs);
      return { present: v !== undefined, value: v };
    }
  }
}

/** Exported for tests + reference impls in other languages. */
export const _internals = { parsePath };
