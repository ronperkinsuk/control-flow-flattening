#!/usr/bin/env node
/**
 * Control Flow Flattening — zero dependencies, pure JS
 *
 * Pipeline:
 *   source → tokenise() → parse() → cff() → generate() → source
 *
 * Supports enough JS to handle real-world function bodies:
 *   - var/let/const declarations
 *   - if / else
 *   - for, for..in, for..of, while, do..while
 *   - return, throw, break, continue
 *   - try/catch/finally
 *   - switch/case
 *   - function declarations & expressions
 *   - arrow functions  (block body)
 *   - class declarations & expressions
 *   - expressions, assignments, calls, template literals,
 *     spread, destructuring, optional chaining (?.), nullish (??)
 *
 * Usage:
 *   node cff.js input.js
 *   node cff.js input.js output.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");

/* ═══════════════════════════════════════════════════════════════════
   1. TOKENISER
   ═══════════════════════════════════════════════════════════════════ */

const TT = {
  NUM: "NUM", STR: "STR", TMPL: "TMPL", REGEX: "REGEX",
  IDENT: "IDENT", PUNCT: "PUNCT", EOF: "EOF",
};

const KW = new Set([
  "await","break","case","catch","class","const","continue","debugger",
  "default","delete","do","else","export","extends","finally","for",
  "function","if","import","in","instanceof","let","new","of","return",
  "static","super","switch","this","throw","try","typeof","var","void",
  "while","with","yield","async","from","as","get","set","target",
]);

// Operator / punctuation tokens, longest-match first
const PUNCTS = [
  "...", "??=", "&&=", "||=",
  "===","!==",">>>","**=","<<=",">>=",
  "==","!=","<=",">=","=>","**","++","--","&&","||","??",
  "+=","-=","*=","/=","%=","&=","|=","^=","?.","<<",">>",
  "+","-","*","/","%","&","|","^","~","!","<",">","=","?",":",
  ".","[","]","(",")","{","}",";",",","@",
];

function tokenise(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;

  let lastTok = null; // used for regex disambiguation

  while (i < len) {
    // whitespace / newlines
    if (/\s/.test(src[i])) { i++; continue; }

    // line comment
    if (src[i] === "/" && src[i+1] === "/") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }

    // block comment
    if (src[i] === "/" && src[i+1] === "*") {
      i += 2;
      while (i < len && !(src[i] === "*" && src[i+1] === "/")) i++;
      i += 2;
      continue;
    }

    const start = i;

    // template literal (simplified — no nested ${} nesting depth tracking)
    if (src[i] === "`") {
      i++;
      let val = "`";
      while (i < len) {
        if (src[i] === "\\" ) { val += src[i] + src[i+1]; i += 2; continue; }
        if (src[i] === "`")  { val += "`"; i++; break; }
        if (src[i] === "$" && src[i+1] === "{") {
          // collect until matching }
          val += "${"; i += 2;
          let depth = 1;
          while (i < len && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") { depth--; if (depth === 0) { val += "}"; i++; break; } }
            val += src[i++];
          }
          continue;
        }
        val += src[i++];
      }
      const tok = { type: TT.TMPL, value: val, start };
      tokens.push(tok); lastTok = tok; continue;
    }

    // string
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i++];
      let val = q;
      while (i < len && src[i] !== q) {
        if (src[i] === "\\") { val += src[i] + src[i+1]; i += 2; continue; }
        val += src[i++];
      }
      val += q; i++;
      const tok = { type: TT.STR, value: val, start };
      tokens.push(tok); lastTok = tok; continue;
    }

    // numeric
    if (/[0-9]/.test(src[i]) || (src[i] === "." && /[0-9]/.test(src[i+1]))) {
      let val = "";
      if (src[i] === "0" && (src[i+1] === "x" || src[i+1] === "X")) {
        val = src[i] + src[i+1]; i += 2;
        while (i < len && /[0-9a-fA-F_]/.test(src[i])) val += src[i++];
      } else if (src[i] === "0" && (src[i+1] === "b" || src[i+1] === "B")) {
        val = src[i] + src[i+1]; i += 2;
        while (i < len && /[01_]/.test(src[i])) val += src[i++];
      } else {
        while (i < len && /[0-9_]/.test(src[i])) val += src[i++];
        if (i < len && src[i] === ".") { val += src[i++]; while (i < len && /[0-9_]/.test(src[i])) val += src[i++]; }
        if (i < len && /[eE]/.test(src[i])) { val += src[i++]; if (/[+-]/.test(src[i])) val += src[i++]; while (i < len && /[0-9]/.test(src[i])) val += src[i++]; }
        if (i < len && src[i] === "n") val += src[i++]; // BigInt
      }
      const tok = { type: TT.NUM, value: val, start };
      tokens.push(tok); lastTok = tok; continue;
    }

    // regex — heuristic: / after operator / keyword / open paren is regex
    if (src[i] === "/") {
      const prev = lastTok;
      const isRegex = !prev
        || prev.type === TT.PUNCT && /^[=(:,!&|?+\-*%^~<>\[{;,]$|^(=>|&&|\|\||return)$/.test(prev.value)
        || prev.type === TT.IDENT && KW.has(prev.value);
      if (isRegex) {
        let val = "/"; i++;
        while (i < len && src[i] !== "/" && src[i] !== "\n") {
          if (src[i] === "\\") { val += src[i] + src[i+1]; i += 2; continue; }
          if (src[i] === "[") { val += src[i++]; while (i < len && src[i] !== "]") { if (src[i] === "\\") { val += src[i++]; } val += src[i++]; } }
          val += src[i++];
        }
        val += src[i++]; // closing /
        while (i < len && /[gimsuy]/.test(src[i])) val += src[i++];
        const tok = { type: TT.REGEX, value: val, start };
        tokens.push(tok); lastTok = tok; continue;
      }
    }

    // identifier / keyword
    if (/[a-zA-Z_$#]/.test(src[i])) {
      let val = "";
      while (i < len && /[a-zA-Z0-9_$]/.test(src[i])) val += src[i++];
      const tok = { type: TT.IDENT, value: val, start };
      tokens.push(tok); lastTok = tok; continue;
    }

    // punctuation (longest match)
    let matched = false;
    for (const p of PUNCTS) {
      if (src.startsWith(p, i)) {
        const tok = { type: TT.PUNCT, value: p, start };
        tokens.push(tok); lastTok = tok;
        i += p.length; matched = true; break;
      }
    }
    if (matched) continue;

    // unknown char — pass through
    const tok = { type: TT.PUNCT, value: src[i], start };
    tokens.push(tok); lastTok = tok; i++;
  }

  tokens.push({ type: TT.EOF, value: "", start: i });
  return tokens;
}

/* ═══════════════════════════════════════════════════════════════════
   2. PARSER  (recursive descent → ESTree-compatible AST)
   ═══════════════════════════════════════════════════════════════════ */

function parse(tokens) {
  let pos = 0;

  const peek  = ()    => tokens[pos];
  const next  = ()    => tokens[pos++];
  const eof   = ()    => tokens[pos].type === TT.EOF;

  const isVal = (v)   => tokens[pos].value === v;
  const isType= (t)   => tokens[pos].type  === t;

  function expect(val) {
    const t = next();
    if (t.value !== val) throw new Error(`Expected '${val}', got '${t.value}' at pos ${t.start}`);
    return t;
  }

  function eat(val) {
    if (isVal(val)) { next(); return true; }
    return false;
  }

  function eatSemi() {
    eat(";");
  }

  // ── statements ──────────────────────────────────────────────────

  function parseProgram() {
    const body = [];
    while (!eof()) body.push(parseStatement());
    return { type: "Program", body };
  }

  function parseStatement() {
    const t = peek();

    if (t.type === TT.IDENT || t.type === TT.PUNCT) {
      switch (t.value) {
        case "{":        return parseBlock();
        case "var":
        case "let":
        case "const":    return parseVarDecl();
        case "function": return parseFunctionDecl();
        case "class":    return parseClassDecl();
        case "return":   return parseReturn();
        case "throw":    return parseThrow();
        case "if":       return parseIf();
        case "for":      return parseFor();
        case "while":    return parseWhile();
        case "do":       return parseDoWhile();
        case "switch":   return parseSwitch();
        case "break":    return parseBreak();
        case "continue": return parseContinue();
        case "try":      return parseTry();
        case "debugger": next(); eatSemi(); return { type: "DebuggerStatement" };
        case "import":   return parseImport();
        case "export":   return parseExport();
        case ";":        next(); return { type: "EmptyStatement" };
        case "async": {
          // async function or async arrow
          const saved = pos;
          next(); // eat 'async'
          if (isVal("function")) return parseFunctionDecl(true);
          pos = saved;
          break; // fall through to expression statement
        }
      }
    }

    // labelled statement
    if (t.type === TT.IDENT && tokens[pos+1]?.value === ":") {
      const label = next().value; next();
      const body  = parseStatement();
      return { type: "LabeledStatement", label: { type: "Identifier", name: label }, body };
    }

    // expression statement
    const expr = parseExpression();
    eatSemi();
    return { type: "ExpressionStatement", expression: expr };
  }

  function parseBlock() {
    expect("{");
    const body = [];
    while (!isVal("}") && !eof()) body.push(parseStatement());
    expect("}");
    return { type: "BlockStatement", body };
  }

  function parseVarDecl(noSemi = false) {
    const kind = next().value; // var | let | const
    const declarations = [];
    do {
      const id   = parsePattern();
      const init = eat("=") ? parseAssignment() : null;
      declarations.push({ type: "VariableDeclarator", id, init });
    } while (eat(","));
    if (!noSemi) eatSemi();
    return { type: "VariableDeclaration", kind, declarations };
  }

  function parseFunctionDecl(isAsync = false) {
    eat("async");
    expect("function");
    const generator = eat("*");
    const id = (isType(TT.IDENT) && !isVal("(")) ? { type: "Identifier", name: next().value } : null;
    const { params, body } = parseFunctionRest();
    return { type: "FunctionDeclaration", id, params, body, async: isAsync, generator };
  }

  function parseFunctionExpr(isAsync = false) {
    eat("async");
    expect("function");
    const generator = eat("*");
    const id = (isType(TT.IDENT) && !isVal("(")) ? { type: "Identifier", name: next().value } : null;
    const { params, body } = parseFunctionRest();
    return { type: "FunctionExpression", id, params, body, async: isAsync, generator };
  }

  function parseFunctionRest() {
    expect("(");
    const params = parseParams();
    expect(")");
    const body = parseBlock();
    return { params, body };
  }

  function parseParams() {
    const params = [];
    while (!isVal(")") && !eof()) {
      if (eat("...")) { params.push({ type: "RestElement", argument: parsePattern() }); break; }
      const p = parsePattern();
      const def = eat("=") ? parseAssignment() : null;
      params.push(def ? { type: "AssignmentPattern", left: p, right: def } : p);
      if (!eat(",")) break;
    }
    return params;
  }

  function parseClassDecl() {
    expect("class");
    const id    = isType(TT.IDENT) ? { type: "Identifier", name: next().value } : null;
    const sup   = eat("extends") ? parseLeftHandSide() : null;
    expect("{");
    const body  = [];
    while (!isVal("}") && !eof()) {
      const isStatic = eat("static");
      const isAsync  = eat("async");
      const isGen    = eat("*");
      let kind = "method";
      let computed = false;
      let key;
      if (isVal("get") || isVal("set")) { kind = next().value; }
      if (eat("[")) { key = parseAssignment(); expect("]"); computed = true; }
      else { key = isType(TT.IDENT)||isType(TT.STR)||isType(TT.NUM) ? parsePrimary() : parsePrimary(); }
      if (isVal("(")) {
        const { params, body: mb } = parseFunctionRest();
        body.push({ type: "MethodDefinition", key, kind, static: isStatic, computed,
          value: { type: "FunctionExpression", params, body: mb, async: isAsync, generator: isGen } });
      } else {
        // class field
        const val = eat("=") ? parseAssignment() : null;
        eatSemi();
        body.push({ type: "PropertyDefinition", key, value: val, static: isStatic, computed });
      }
    }
    expect("}");
    return { type: "ClassDeclaration", id, superClass: sup, body: { type: "ClassBody", body } };
  }

  function parseReturn() {
    expect("return");
    const arg = (!isVal(";") && !isVal("}") && !eof()) ? parseExpression() : null;
    eatSemi();
    return { type: "ReturnStatement", argument: arg };
  }

  function parseThrow() {
    expect("throw");
    const arg = parseExpression();
    eatSemi();
    return { type: "ThrowStatement", argument: arg };
  }

  function parseIf() {
    expect("if"); expect("(");
    const test = parseExpression();
    expect(")");
    const consequent = parseStatement();
    const alternate  = eat("else") ? parseStatement() : null;
    return { type: "IfStatement", test, consequent, alternate };
  }

  function parseFor() {
    expect("for");
    const isAwait = eat("await");
    expect("(");

    let init = null;
    if (!isVal(";")) {
      if (isVal("var")||isVal("let")||isVal("const")) {
        init = parseVarDecl(true);
      } else {
        init = parseExpression();
      }
    }

    // for..of / for..in
    if (eat("of")) {
      const right = parseAssignment();
      expect(")");
      return { type: "ForOfStatement", await: isAwait, left: init, right, body: parseStatement() };
    }
    if (eat("in")) {
      const right = parseExpression();
      expect(")");
      return { type: "ForInStatement", left: init, right, body: parseStatement() };
    }

    expect(";");
    const test   = isVal(";") ? null : parseExpression(); expect(";");
    const update = isVal(")") ? null : parseExpression();
    expect(")");
    return { type: "ForStatement", init, test, update, body: parseStatement() };
  }

  function parseWhile() {
    expect("while"); expect("(");
    const test = parseExpression();
    expect(")");
    return { type: "WhileStatement", test, body: parseStatement() };
  }

  function parseDoWhile() {
    expect("do");
    const body = parseStatement();
    expect("while"); expect("(");
    const test = parseExpression();
    expect(")"); eatSemi();
    return { type: "DoWhileStatement", test, body };
  }

  function parseSwitch() {
    expect("switch"); expect("(");
    const disc = parseExpression();
    expect(")"); expect("{");
    const cases = [];
    while (!isVal("}") && !eof()) {
      const test = eat("case") ? parseExpression() : (expect("default"), null);
      expect(":");
      const consequent = [];
      while (!isVal("case") && !isVal("default") && !isVal("}") && !eof())
        consequent.push(parseStatement());
      cases.push({ type: "SwitchCase", test, consequent });
    }
    expect("}");
    return { type: "SwitchStatement", discriminant: disc, cases };
  }

  function parseBreak() {
    expect("break");
    const label = (!isVal(";") && !isVal("}") && isType(TT.IDENT)) ? { type: "Identifier", name: next().value } : null;
    eatSemi();
    return { type: "BreakStatement", label };
  }

  function parseContinue() {
    expect("continue");
    const label = (!isVal(";") && !isVal("}") && isType(TT.IDENT)) ? { type: "Identifier", name: next().value } : null;
    eatSemi();
    return { type: "ContinueStatement", label };
  }

  function parseTry() {
    expect("try");
    const block   = parseBlock();
    let handler   = null, finalizer = null;
    if (eat("catch")) {
      let param = null;
      if (eat("(")) { param = parsePattern(); expect(")"); }
      handler = { type: "CatchClause", param, body: parseBlock() };
    }
    if (eat("finally")) finalizer = parseBlock();
    return { type: "TryStatement", block, handler, finalizer };
  }

  function parseImport() {
    // pass-through: collect tokens until end of import declaration
    const start = pos - 1;
    let raw = "import";
    // simplistic: read until ';' or newline after string
    if (isType(TT.STR)) { raw += " " + next().value; eatSemi(); }
    else {
      while (!isVal(";") && !eof()) raw += " " + next().value;
      eat(";");
    }
    return { type: "_RawStatement", raw };
  }

  function parseExport() {
    expect("export");
    if (isVal("default")) {
      next();
      const dec = isVal("function") ? parseFunctionDecl()
                : isVal("class")    ? parseClassDecl()
                : parseExpression();
      eatSemi();
      return { type: "ExportDefaultDeclaration", declaration: dec };
    }
    if (isVal("function"))  return { type: "ExportNamedDeclaration", declaration: parseFunctionDecl() };
    if (isVal("class"))     return { type: "ExportNamedDeclaration", declaration: parseClassDecl() };
    if (isVal("var")||isVal("let")||isVal("const")) return { type: "ExportNamedDeclaration", declaration: parseVarDecl() };
    // export { a, b as c } from '...'
    let raw = "export";
    while (!isVal(";") && !eof()) raw += " " + next().value;
    eat(";");
    return { type: "_RawStatement", raw };
  }

  // ── expressions ─────────────────────────────────────────────────

  function parseExpression() {
    const expr = parseAssignment();
    if (!eat(",")) return expr;
    const exprs = [expr];
    do { exprs.push(parseAssignment()); } while (eat(","));
    return { type: "SequenceExpression", expressions: exprs };
  }

  function parseAssignment() {
    const left = parseConditional();
    const op   = peek().value;
    if (/^(=|\+=|-=|\*=|\/=|%=|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|>>>=|&=|\|=|\^=)$/.test(op)) {
      next();
      return { type: "AssignmentExpression", operator: op, left, right: parseAssignment() };
    }
    return left;
  }

  function parseConditional() {
    let expr = parseNullish();
    if (eat("?")) {
      const consequent = parseAssignment();
      expect(":");
      const alternate  = parseAssignment();
      expr = { type: "ConditionalExpression", test: expr, consequent, alternate };
    }
    return expr;
  }

  function parseBinary(parseFn, ops) {
    return function () {
      let left = parseFn();
      while (ops.includes(peek().value)) {
        const op = next().value;
        left = { type: "BinaryExpression", operator: op, left, right: parseFn() };
      }
      return left;
    };
  }

  const parseNullish = (() => {
    function parseOr()  {
      let l = parseAnd();
      while (isVal("||")||isVal("??")) { const op=next().value; l={type:"LogicalExpression",operator:op,left:l,right:parseAnd()}; }
      return l;
    }
    function parseAnd() {
      let l = parseBitOr();
      while (isVal("&&")) { next(); l={type:"LogicalExpression",operator:"&&",left:l,right:parseBitOr()}; }
      return l;
    }
    const parseBitOr  = parseBinary(parseBitXor,  ["|"]);
    function parseBitXor() { return parseBinary(parseBitAnd, ["^"])(); }
    function parseBitAnd() { return parseBinary(parseEquality, ["&"])(); }
    function parseEquality() { return parseBinary(parseRelational, ["===","!==","==","!="])(); }
    function parseRelational() { return parseBinary(parseShift, ["<=",">=","<",">","instanceof","in"])(); }
    function parseShift() { return parseBinary(parseAdditive, ["<<",">>>",">>"])(); }
    function parseAdditive() { return parseBinary(parseMulti, ["+","-"])(); }
    function parseMulti() { return parseBinary(parseExponent, ["*","/","%"])(); }
    function parseExponent() {
      let l = parseUnary();
      if (isVal("**")) { next(); l = { type:"BinaryExpression", operator:"**", left:l, right:parseExponent() }; }
      return l;
    }
    return parseOr;
  })();

  function parseUnary() {
    const op = peek().value;
    if (["!","~","+","-","typeof","void","delete","await"].includes(op)) {
      next();
      return { type: "UnaryExpression", operator: op, prefix: true, argument: parseUnary() };
    }
    if (isVal("++") || isVal("--")) {
      const op = next().value;
      return { type: "UpdateExpression", operator: op, prefix: true, argument: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let expr = parseCallMember();
    if ((isVal("++") || isVal("--")) && !peek().hadNewlineBefore) {
      expr = { type: "UpdateExpression", operator: next().value, prefix: false, argument: expr };
    }
    return expr;
  }

  function parseCallMember() {
    let expr = parseLeftHandSide();
    while (true) {
      if (eat("(")) {
        expr = { type: "CallExpression", callee: expr, arguments: parseArgList() };
      } else if (eat("?.")) {
        if (isVal("(")) { next(); expr = { type: "OptionalCallExpression", callee: expr, arguments: parseArgList(), optional: true }; }
        else if (eat("[")) { const prop = parseExpression(); expect("]"); expr = { type: "OptionalMemberExpression", object: expr, property: prop, computed: true, optional: true }; }
        else { expr = { type: "OptionalMemberExpression", object: expr, property: { type:"Identifier",name:next().value }, computed: false, optional: true }; }
      } else if (eat("[")) {
        const prop = parseExpression(); expect("]");
        expr = { type: "MemberExpression", object: expr, property: prop, computed: true };
      } else if (eat(".")) {
        const prop = { type: "Identifier", name: next().value };
        expr = { type: "MemberExpression", object: expr, property: prop, computed: false };
      } else if (isType(TT.TMPL)) {
        expr = { type: "TaggedTemplateExpression", tag: expr, quasi: { type: "TemplateLiteral", raw: next().value } };
      } else {
        break;
      }
    }
    return expr;
  }

  function parseArgList() {
    const args = [];
    while (!isVal(")") && !eof()) {
      if (eat("...")) args.push({ type: "SpreadElement", argument: parseAssignment() });
      else            args.push(parseAssignment());
      if (!eat(",")) break;
    }
    expect(")");
    return args;
  }

  function parseLeftHandSide() {
    if (isVal("new")) {
      next();
      if (isVal("new") || !isVal(".")) {
        const callee = parseLeftHandSide();
        const args   = eat("(") ? parseArgList() : [];
        return { type: "NewExpression", callee, arguments: args };
      }
      // new.target
      expect("."); expect("target");
      return { type: "MetaProperty", meta: {type:"Identifier",name:"new"}, property: {type:"Identifier",name:"target"} };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();

    // parenthesised / arrow params
    if (t.value === "(") {
      next();
      if (isVal(")")) { next(); expect("=>"); return parseArrow([]); }
      const expr = parseExpression();
      expect(")");
      if (isVal("=>")) { next(); return parseArrow(exprToParams(expr)); }
      return expr;
    }

    // arrow with single ident param
    if (t.type === TT.IDENT && tokens[pos+1]?.value === "=>") {
      const param = [{ type:"Identifier", name: next().value }];
      next(); // =>
      return parseArrow(param);
    }

    if (t.type === TT.NUM)   { next(); return { type:"Literal",    value:+t.value, raw:t.value }; }
    if (t.type === TT.STR)   { next(); return { type:"Literal",    value:t.value,  raw:t.value }; }
    if (t.type === TT.REGEX) { next(); return { type:"Literal",    regex:t.value,  raw:t.value }; }
    if (t.type === TT.TMPL)  { next(); return { type:"TemplateLiteral", raw:t.value }; }

    if (t.type === TT.IDENT) {
      switch (t.value) {
        case "true":     next(); return { type:"Literal",  value:true };
        case "false":    next(); return { type:"Literal",  value:false };
        case "null":     next(); return { type:"Literal",  value:null };
        case "this":     next(); return { type:"ThisExpression" };
        case "super":    next(); return { type:"Super" };
        case "function": return parseFunctionExpr();
        case "class": {
          next();
          const id  = isType(TT.IDENT) && !isVal("extends") && !isVal("{") ? { type:"Identifier",name:next().value } : null;
          const sup = eat("extends") ? parseLeftHandSide() : null;
          const body= [];
          expect("{");
          while (!isVal("}") && !eof()) {
            const st = eat("static"); const ak = eat("async"); const gen = eat("*");
            let kind="method", comp=false, key;
            if ((isVal("get")||isVal("set")) && tokens[pos+1]?.value!=="(") kind=next().value;
            if (eat("[")) { key=parseAssignment(); expect("]"); comp=true; }
            else { key = parsePrimary(); }
            if (isVal("(")) {
              const {params,body:mb}=parseFunctionRest();
              body.push({type:"MethodDefinition",key,kind,static:st,computed:comp,value:{type:"FunctionExpression",params,body:mb,async:ak,generator:gen}});
            } else { const v=eat("=")?parseAssignment():null; eatSemi(); body.push({type:"PropertyDefinition",key,value:v,static:st,computed:comp}); }
          }
          expect("}");
          return { type:"ClassExpression", id, superClass:sup, body:{type:"ClassBody",body} };
        }
        case "async": {
          // async arrow or async function expr
          next();
          if (isVal("function")) return parseFunctionExpr(true);
          if (isVal("(")) { next(); const p=parseParams(); expect(")"); expect("=>"); return parseArrow(p,true); }
          if (isType(TT.IDENT)) { const p=[{type:"Identifier",name:next().value}]; expect("=>"); return parseArrow(p,true); }
          // fall: identifier named 'async'
          return { type:"Identifier", name:"async" };
        }
        case "yield": {
          next();
          const delegate = eat("*");
          const arg = (!isVal(";")&&!isVal("}")&&!isVal(")")&&!isVal(",")&&!eof()) ? parseAssignment() : null;
          return { type:"YieldExpression", delegate, argument:arg };
        }
      }
      next();
      return { type:"Identifier", name:t.value };
    }

    // array literal
    if (t.value === "[") {
      next();
      const elements = [];
      while (!isVal("]") && !eof()) {
        if (isVal(",")) { elements.push(null); next(); continue; }
        if (eat("...")) { elements.push({type:"SpreadElement",argument:parseAssignment()}); eat(","); continue; }
        elements.push(parseAssignment()); eat(",");
      }
      expect("]");
      return { type:"ArrayExpression", elements };
    }

    // object literal
    if (t.value === "{") {
      next();
      const props = [];
      while (!isVal("}") && !eof()) {
        if (eat("...")) { props.push({type:"SpreadElement",argument:parseAssignment()}); eat(","); continue; }
        const isAsync = eat("async");
        const isGen   = eat("*");
        let kind = "init", computed = false, key;
        if ((isVal("get")||isVal("set")) && tokens[pos+1]?.value !== ":"  && tokens[pos+1]?.value !== ",") kind = next().value;
        if (eat("[")) { key=parseAssignment(); expect("]"); computed=true; }
        else { key = parsePrimary(); }

        if (isVal("(")) {
          const {params,body} = parseFunctionRest();
          props.push({type:"Property",key,kind,computed,shorthand:false,method:true,
            value:{type:"FunctionExpression",params,body,async:isAsync,generator:isGen}});
        } else if (eat(":")) {
          props.push({type:"Property",key,kind,computed,shorthand:false,method:false,value:parseAssignment()});
        } else {
          // shorthand  { x }  or  { x = def }
          const def = eat("=") ? parseAssignment() : null;
          props.push({type:"Property",key,kind:"init",computed:false,shorthand:true,method:false,
            value: def ? {type:"AssignmentPattern",left:key,right:def} : key});
        }
        eat(",");
      }
      expect("}");
      return { type:"ObjectExpression", properties:props };
    }

    throw new Error(`Unexpected token '${t.value}' (${t.type}) at pos ${t.start}`);
  }

  function parseArrow(params, isAsync = false) {
    const body = isVal("{") ? parseBlock() : parseAssignment();
    return { type:"ArrowFunctionExpression", params, body, async:isAsync,
             expression: body.type !== "BlockStatement" };
  }

  function exprToParams(expr) {
    if (expr.type === "SequenceExpression") return expr.expressions.map(exprToParams).flat();
    if (expr.type === "Identifier") return [expr];
    if (expr.type === "AssignmentExpression") return [{ type:"AssignmentPattern", left:expr.left, right:expr.right }];
    if (expr.type === "SpreadElement") return [{ type:"RestElement", argument:expr.argument }];
    if (expr.type === "ArrayExpression") return [{ type:"ArrayPattern", elements:expr.elements }];
    if (expr.type === "ObjectExpression") return [{ type:"ObjectPattern", properties:expr.properties }];
    return [expr];
  }

  // ── patterns ────────────────────────────────────────────────────

  function parsePattern() {
    if (isVal("[")) {
      next();
      const elements = [];
      while (!isVal("]") && !eof()) {
        if (isVal(",")) { elements.push(null); next(); continue; }
        if (eat("...")) { elements.push({ type:"RestElement", argument:parsePattern() }); break; }
        const p = parsePattern();
        const d = eat("=") ? parseAssignment() : null;
        elements.push(d ? { type:"AssignmentPattern", left:p, right:d } : p);
        eat(",");
      }
      expect("]");
      return { type:"ArrayPattern", elements };
    }
    if (isVal("{")) {
      next();
      const props = [];
      while (!isVal("}") && !eof()) {
        if (eat("...")) { props.push({type:"RestElement",argument:parsePattern()}); break; }
        let key, computed = false;
        if (eat("[")) { key=parseAssignment(); expect("]"); computed=true; }
        else { key = parsePrimary(); }
        if (eat(":")) {
          const val = parsePattern();
          const def = eat("=") ? parseAssignment() : null;
          props.push({type:"Property",key,computed,shorthand:false,
            value: def?{type:"AssignmentPattern",left:val,right:def}:val});
        } else {
          const def = eat("=") ? parseAssignment() : null;
          props.push({type:"Property",key,computed,shorthand:true,
            value: def?{type:"AssignmentPattern",left:key,right:def}:key});
        }
        eat(",");
      }
      expect("}");
      return { type:"ObjectPattern", properties:props };
    }
    if (eat("...")) return { type:"RestElement", argument:parsePattern() };
    return { type:"Identifier", name:next().value };
  }

  return parseProgram();
}

/* ═══════════════════════════════════════════════════════════════════
   3. CFF TRANSFORM
   ═══════════════════════════════════════════════════════════════════ */

let _uid = 0;
const freshVar = () => `_s${_uid++}`;

const TERMINATORS = new Set(["ReturnStatement","ThrowStatement","BreakStatement","ContinueStatement"]);
const CONTROL     = new Set(["IfStatement","ForStatement","ForInStatement","ForOfStatement",
                             "WhileStatement","DoWhileStatement","TryStatement","SwitchStatement"]);

function splitBlocks(stmts) {
  const blocks = []; let cur = [];
  const flush  = () => { if (cur.length) { blocks.push(cur); cur = []; } };
  for (const s of stmts) {
    if (TERMINATORS.has(s.type) || CONTROL.has(s.type)) { flush(); blocks.push([s]); }
    else cur.push(s);
  }
  flush();
  return blocks;
}

function hoistVars(stmts) {
  // Convert all let/const to var so they're function-scoped across switch cases
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclaration" && (node.kind === "let" || node.kind === "const")) {
      node.kind = "var";
    }
    // Don't descend into nested functions — they have their own scope
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") return;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && child.type) visit(child);
    }
  }
  stmts.forEach(visit);
}

function flattenBlock(blockNode) {
  if (!blockNode || blockNode.type !== "BlockStatement") return blockNode;
  const stmts = blockNode.body;
  if (stmts.length < 2) return blockNode;

  const blocks = splitBlocks(stmts);
  if (blocks.length < 2) return blockNode;

  // Must convert let/const → var before splitting into cases,
  // otherwise block-scoped bindings won't be visible across case boundaries
  hoistVars(stmts);

  const sv      = freshVar();
  const loopLbl = "_cff";

  const cases = blocks.map((stmts, i) => {
    const last  = stmts[stmts.length - 1];
    const inner = [...stmts];
    if (!TERMINATORS.has(last.type)) {
      const next = i + 1;
      inner.push(next < blocks.length
        ? { type:"ExpressionStatement", expression:{ type:"AssignmentExpression", operator:"=",
            left:{type:"Identifier",name:sv}, right:{type:"Literal",value:next,raw:String(next)} }}
        : { type:"BreakStatement", label:{type:"Identifier",name:loopLbl} }
      );
    }
    return {
      type: "SwitchCase",
      test: { type:"Literal", value:i, raw:String(i) },
      consequent: [{ type:"BlockStatement", body:inner }, { type:"BreakStatement", label:null }],
    };
  });

  cases.push({ type:"SwitchCase", test:null,
    consequent:[{ type:"BreakStatement", label:{type:"Identifier",name:loopLbl} }] });

  return {
    type: "BlockStatement",
    body: [
      { type:"VariableDeclaration", kind:"let", declarations:[
          { type:"VariableDeclarator", id:{type:"Identifier",name:sv},
            init:{type:"Literal",value:0,raw:"0"} }]},
      { type:"LabeledStatement", label:{type:"Identifier",name:loopLbl},
        body:{ type:"WhileStatement", test:{type:"Literal",value:true,raw:"true"},
          body:{ type:"BlockStatement", body:[
            { type:"SwitchStatement", discriminant:{type:"Identifier",name:sv}, cases }
          ]}}}
    ],
  };
}

function walkAndFlatten(node) {
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => walkAndFlatten(c));
    else if (child && typeof child === "object" && child.type) walkAndFlatten(child);
  }
  // After visiting children, flatten this node's body if it's a function
  const FN = new Set(["FunctionDeclaration","FunctionExpression","ArrowFunctionExpression"]);
  if (FN.has(node.type) && node.body?.type === "BlockStatement") {
    node.body = flattenBlock(node.body);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   4. CODE GENERATOR  (AST → source string)
   ═══════════════════════════════════════════════════════════════════ */

function generate(node, ind = "") {
  if (!node) return "";
  const i2 = ind + "  ";

  switch (node.type) {

    case "Program":
      return node.body.map(s => generate(s, ind)).join("\n");

    case "_RawStatement":
      return node.raw + ";";

    // ── declarations ──────────────────────────────────────────────
    case "VariableDeclaration": {
      const decls = node.declarations.map(d =>
        generate(d.id, ind) + (d.init != null ? " = " + generate(d.init, ind) : "")
      ).join(", ");
      return `${ind}${node.kind} ${decls};`;
    }

    case "FunctionDeclaration":
      return `${ind}${node.async?"async ":""}function${node.generator?"*":""} ${node.id?node.id.name:""}(${node.params.map(p=>generate(p,"")).join(", ")}) ${generate(node.body, ind)}`;

    case "ClassDeclaration":
    case "ClassExpression": {
      const sup = node.superClass ? ` extends ${generate(node.superClass,"")}` : "";
      const members = node.body.body.map(m => generate(m, i2)).join("\n");
      return `${ind}${node.type==="ClassDeclaration"?"":""}class${node.id?" "+node.id.name:""}${sup} {\n${members}\n${ind}}`;
    }
    case "MethodDefinition": {
      const kw = node.kind === "method" ? "" : node.kind + " ";
      const st = node.static ? "static " : "";
      const fn = node.value;
      const ak = fn.async ? "async " : "";
      const gn = fn.generator ? "*" : "";
      const key = node.computed ? `[${generate(node.key,"")}]` : generate(node.key,"");
      return `${i2}${st}${ak}${kw}${gn}${key}(${fn.params.map(p=>generate(p,"")).join(", ")}) ${generate(fn.body, i2)}`;
    }
    case "PropertyDefinition": {
      const st = node.static ? "static " : "";
      const key = node.computed ? `[${generate(node.key,"")}]` : generate(node.key,"");
      return `${i2}${st}${key}${node.value ? " = " + generate(node.value,"") : ""};`;
    }

    // ── statements ────────────────────────────────────────────────
    case "ExpressionStatement":
      return `${ind}${generate(node.expression, "")};`;

    case "BlockStatement":
      if (node.body.length === 0) return "{}";
      return `{\n${node.body.map(s=>generate(s,i2)).join("\n")}\n${ind}}`;

    case "EmptyStatement":
      return `${ind};`;

    case "ReturnStatement":
      return `${ind}return${node.argument ? " " + generate(node.argument,"") : ""};`;

    case "ThrowStatement":
      return `${ind}throw ${generate(node.argument,"")};`;

    case "BreakStatement":
      return `${ind}break${node.label ? " "+node.label.name : ""};`;

    case "ContinueStatement":
      return `${ind}continue${node.label ? " "+node.label.name : ""};`;

    case "DebuggerStatement":
      return `${ind}debugger;`;

    case "IfStatement": {
      let s = `${ind}if (${generate(node.test,"")}) ${generate(node.consequent,ind).trimStart()}`;
      if (node.alternate) s += ` else ${generate(node.alternate,ind).trimStart()}`;
      return s;
    }

    case "WhileStatement":
      return `${ind}while (${generate(node.test,"")}) ${generate(node.body,ind).trimStart()}`;

    case "DoWhileStatement":
      return `${ind}do ${generate(node.body,ind).trimStart()} while (${generate(node.test,"")});`;

    case "ForStatement": {
      const init   = node.init   ? generate(node.init,"").replace(/;\s*$/,"") : "";
      const test   = node.test   ? generate(node.test,"")   : "";
      const update = node.update ? generate(node.update,"") : "";
      return `${ind}for (${init}; ${test}; ${update}) ${generate(node.body,ind).trimStart()}`;
    }
    case "ForInStatement":
      return `${ind}for (${generate(node.left,"").replace(/;\s*$/,"")} in ${generate(node.right,"")}) ${generate(node.body,ind).trimStart()}`;
    case "ForOfStatement":
      return `${ind}for${node.await?" await":""} (${generate(node.left,"").replace(/;\s*$/,"")} of ${generate(node.right,"")}) ${generate(node.body,ind).trimStart()}`;

    case "SwitchStatement": {
      const cases = node.cases.map(c => {
        const head = c.test !== null ? `${i2}case ${generate(c.test,"")}:` : `${i2}default:`;
        const body = c.consequent.map(s => generate(s, i2+"  ")).join("\n");
        return head + (body ? "\n"+body : "");
      }).join("\n");
      return `${ind}switch (${generate(node.discriminant,"")}) {\n${cases}\n${ind}}`;
    }

    case "TryStatement": {
      let s = `${ind}try ${generate(node.block,ind).trimStart()}`;
      if (node.handler) {
        const p = node.handler.param ? `(${generate(node.handler.param,"")})` : "()";
        s += ` catch ${p} ${generate(node.handler.body,ind).trimStart()}`;
      }
      if (node.finalizer) s += ` finally ${generate(node.finalizer,ind).trimStart()}`;
      return s;
    }

    case "LabeledStatement":
      return `${ind}${node.label.name}: ${generate(node.body,ind).trimStart()}`;

    case "ExportDefaultDeclaration":
      return `${ind}export default ${generate(node.declaration,ind).trimStart()}`;
    case "ExportNamedDeclaration":
      return `${ind}export ${generate(node.declaration,ind).trimStart()}`;

    // ── expressions ───────────────────────────────────────────────
    case "Identifier":      return node.name;
    case "Literal":
      if (node.regex)   return node.regex;
      if (node.value === null)  return "null";
      if (typeof node.value === "string") return node.raw ?? JSON.stringify(node.value);
      return node.raw ?? String(node.value);

    case "TemplateLiteral": return node.raw;
    case "TaggedTemplateExpression": return `${generate(node.tag,"")}${node.quasi.raw}`;

    case "ThisExpression":   return "this";
    case "Super":            return "super";
    case "MetaProperty":     return `${node.meta.name}.${node.property.name}`;

    case "AssignmentExpression":
    case "BinaryExpression":
    case "LogicalExpression":
      return `(${generate(node.left,"")} ${node.operator} ${generate(node.right,"")})`;

    case "UnaryExpression":
      return node.prefix
        ? `${node.operator}${/\w/.test(node.operator)?` `:""}${generate(node.argument,"")}`
        : `${generate(node.argument,"")}${node.operator}`;

    case "UpdateExpression":
      return node.prefix ? `${node.operator}${generate(node.argument,"")}` : `${generate(node.argument,"")}${node.operator}`;

    case "ConditionalExpression":
      return `(${generate(node.test,"")} ? ${generate(node.consequent,"")} : ${generate(node.alternate,"")})`;

    case "SequenceExpression":
      return node.expressions.map(e=>generate(e,"")).join(", ");

    case "MemberExpression":
    case "OptionalMemberExpression":
      return node.computed
        ? `${generate(node.object,"")}${node.optional?"?.":""}[${generate(node.property,"")}]`
        : `${generate(node.object,"")}${node.optional?"?.":"."}${generate(node.property,"")}`;

    case "CallExpression":
    case "OptionalCallExpression":
      return `${generate(node.callee,"")}${node.optional?"?.":""}(${node.arguments.map(a=>generate(a,"")).join(", ")})`;

    case "NewExpression":
      return `new ${generate(node.callee,"")}(${node.arguments.map(a=>generate(a,"")).join(", ")})`;

    case "SpreadElement":
      return `...${generate(node.argument,"")}`;

    case "YieldExpression":
      return `yield${node.delegate?"*":""} ${generate(node.argument,"")}`;

    case "ArrayExpression":
      return `[${node.elements.map(e=>e?generate(e,""):"").join(", ")}]`;

    case "ObjectExpression": {
      const props = node.properties.map(p => {
        if (p.type === "SpreadElement") return `...${generate(p.argument,"")}`;
        const key = p.computed ? `[${generate(p.key,"")}]` : generate(p.key,"");
        if (p.method) return `${key}(${p.value.params.map(x=>generate(x,"")).join(", ")}) ${generate(p.value.body,"")}`;
        if (p.shorthand) return key;
        return `${key}: ${generate(p.value,"")}`;
      });
      return `{ ${props.join(", ")} }`;
    }

    case "FunctionExpression":
      return `${node.async?"async ":""}function${node.generator?"*":""} ${node.id?node.id.name:""}(${node.params.map(p=>generate(p,"")).join(", ")}) ${generate(node.body, ind)}`;

    case "ArrowFunctionExpression":
      return `${node.async?"async ":""}(${node.params.map(p=>generate(p,"")).join(", ")}) => ${generate(node.body, ind)}`;

    case "ClassDeclaration":
    case "ClassExpression": {
      const sup = node.superClass ? ` extends ${generate(node.superClass,"")}` : "";
      const members = node.body.body.map(m => generate(m, i2)).join("\n");
      return `class${node.id?" "+node.id.name:""}${sup} {\n${members}\n${ind}}`;
    }

    // ── patterns ──────────────────────────────────────────────────
    case "AssignmentPattern":
      return `${generate(node.left,"")} = ${generate(node.right,"")}`;
    case "RestElement":
      return `...${generate(node.argument,"")}`;
    case "ArrayPattern":
      return `[${node.elements.map(e=>e?generate(e,""):"").join(", ")}]`;
    case "ObjectPattern": {
      const props = node.properties.map(p => {
        if (p.type === "RestElement") return `...${generate(p.argument,"")}`;
        const key = p.computed ? `[${generate(p.key,"")}]` : generate(p.key,"");
        return p.shorthand ? generate(p.value,"") : `${key}: ${generate(p.value,"")}`;
      });
      return `{ ${props.join(", ")} }`;
    }

    default:
      return `/* unsupported:${node.type} */`;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   5. MAIN
   ═══════════════════════════════════════════════════════════════════ */

function transformCode(src) {
  const tokens = tokenise(src);
  const ast    = parse(tokens);
  walkAndFlatten(ast);
  return generate(ast);
}

const [,, inputFile, outputFile] = process.argv;
if (!inputFile) { console.error("Usage: node cff.js <input.js> [output.js]"); process.exit(1); }

const src    = fs.readFileSync(path.resolve(inputFile), "utf8");
const result = transformCode(src);

if (outputFile) { fs.writeFileSync(path.resolve(outputFile), result, "utf8"); console.log(`Written to ${outputFile}`); }
else            { console.log(result); }