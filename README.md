# Control Flow Flattening for JavaScript

A zero-dependency, pure JavaScript tool that applies **control flow flattening** (CFF) to JavaScript source files. It transforms readable function bodies into opaque `while/switch` state machines, making the code significantly harder to reverse-engineer.

## What It Does

CFF takes each function body, splits it into basic blocks, and rewires control flow through a dispatcher loop:

```js
// Before
function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
  return msg;
}

// After (conceptual)
function greet(name) {
  let _s0 = 0;
  _cff: while (true) {
    switch (_s0) {
      case 0: { var msg = "Hello, " + name; _s0 = 1; break; }
      case 1: { console.log(msg); _s0 = 2; break; }
      case 2: { return msg; }
      default: break _cff;
    }
  }
}
```

## Installation

No installation required. It's a single file with no dependencies — just Node.js.

```bash
git clone https://github.com/ronperkinsuk/cff.js.git
cd cff.js
```

## Usage

```bash
# Output to stdout
node cff.js input.js

# Write to file
node cff.js input.js output.js
```

## Supported Syntax

The built-in parser and code generator handle a broad subset of modern JavaScript:

- `var` / `let` / `const` declarations
- `if` / `else`
- `for`, `for..in`, `for..of`, `while`, `do..while`
- `return`, `throw`, `break`, `continue`
- `try` / `catch` / `finally`
- `switch` / `case`
- Function declarations and expressions
- Arrow functions (block body)
- Class declarations and expressions
- `async` / `await`, generators (`function*`, `yield`)
- Template literals
- Spread / rest, destructuring
- Optional chaining (`?.`), nullish coalescing (`??`)
- `import` / `export` (pass-through)

## How It Works

The pipeline has four stages:

1. **Tokenise** — Lexes source into tokens (identifiers, strings, numbers, punctuation, regex, template literals).
2. **Parse** — Recursive-descent parser produces an ESTree-compatible AST.
3. **CFF Transform** — Walks the AST. For each function body with 2+ basic blocks, it:
   - Splits statements into blocks at control-flow boundaries
   - Hoists `let`/`const` to `var` for cross-case visibility
   - Wraps blocks in numbered `switch` cases inside a labeled `while(true)` loop
4. **Generate** — Serializes the transformed AST back to JavaScript source.

## Limitations

- Intended as an obfuscation pass, not a security boundary. Determined attackers can still deobfuscate.
- Template literal nesting (deeply nested `${}`) is handled heuristically.
- Does not transform module-level statements — only function bodies.
- Output is functionally equivalent but not formatted for readability (that's the point).

## Use Cases

- Pre-publish obfuscation for client-side JavaScript
- Making scrapers / bots harder to write against your frontend code
- Educational tool for understanding CFF as an obfuscation technique

## License

GPL
