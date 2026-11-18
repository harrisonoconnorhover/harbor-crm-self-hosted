import { z } from "zod";

export const reportFormulaSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().min(1).max(80),
  expression: z.string().trim().min(1).max(1000),
  nullAsZero: z.boolean().default(false),
});
export type ReportFormula = z.infer<typeof reportFormulaSchema>;
export type FormulaNode = { type:"number"; value:number } | { type:"field"; id:string }
  | { type:"unary"; sign:1|-1; node:FormulaNode }
  | { type:"binary"; op:"+"|"-"|"*"|"/"; left:FormulaNode; right:FormulaNode };

// A small arithmetic grammar, never JavaScript or user-supplied SQL.
export function parseReportFormula(expression:string): {node:FormulaNode; fields:string[]} {
  if (!expression.trim() || expression.length>1000) throw Error("Enter a formula of 1–1,000 characters.");
  let position=0, tokens=0;
  const fields=new Set<string>();
  const whitespace=()=>{while(/\s/.test(expression[position] || "#")) position++;};
  const fail=():never=>{throw Error(`Check the formula near character ${position+1}. Use numbers, [numeric properties], +, -, *, / and parentheses.`);};
  function atom(depth:number):FormulaNode {
    whitespace();
    if(depth>20) throw Error("Simplify this formula: use at most 200 terms and 20 nested levels.");
    const char=expression[position];
    if(char==="+" || char==="-"){position++;return {type:"unary",sign:char==="-"?-1:1,node:atom(depth+1)};}
    if(char==="("){position++;const node=sum(depth+1);whitespace();if(expression[position++]!==")")fail();return node;}
    if(++tokens>200)throw Error("Simplify this formula: use at most 200 numeric terms.");
    if(char==="["){
      const end=expression.indexOf("]",position+1);if(end<0)fail();
      const id=expression.slice(position+1,end).trim();if(!id || id.length>150)fail();
      position=end+1;fields.add(id);return {type:"field",id};
    }
    const match=expression.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if(!match) return fail();
    position+=match[0].length;const value=Number(match[0]);if(!Number.isFinite(value))throw Error("Formula constants must be finite numbers.");
    return {type:"number",value};
  }
  function product(depth:number):FormulaNode {
    let left=atom(depth);whitespace();
    while(expression[position]==="*" || expression[position]==="/"){
      const op=expression[position++] as "*"|"/";left={type:"binary",op,left,right:atom(depth)};whitespace();
    }
    return left;
  }
  function sum(depth:number):FormulaNode {
    let left=product(depth);whitespace();
    while(expression[position]==="+" || expression[position]==="-"){
      const op=expression[position++] as "+"|"-";left={type:"binary",op,left,right:product(depth)};whitespace();
    }
    return left;
  }
  const node=sum(0);whitespace();if(position!==expression.length)fail();
  // Count arithmetic-tree depth too: a long left-associated chain can exceed
  // SQLite's expression limit even without deeply nested input parentheses.
  const pending:{node:FormulaNode;depth:number}[]=[{node,depth:0}];
  while(pending.length){
    const current=pending.pop()!;
    if(current.depth>20)throw Error("Simplify this formula to at most 20 calculation levels; group long arithmetic chains into smaller parts.");
    if(current.node.type==="unary")pending.push({node:current.node.node,depth:current.depth+1});
    if(current.node.type==="binary")pending.push({node:current.node.left,depth:current.depth+1},{node:current.node.right,depth:current.depth+1});
  }
  return {node,fields:[...fields]};
}
export function evaluateFormula(node:FormulaNode, read:(id:string)=>unknown, nullAsZero=false):number|null {
  function evaluate(n:FormulaNode):number|null {
    if(n.type==="number")return n.value;
    if(n.type==="field"){const value=read(n.id);return typeof value==="number"&&Number.isFinite(value)?value:nullAsZero?0:null;}
    if(n.type==="unary"){const value=evaluate(n.node);return value===null?null:n.sign*value;}
    const a=evaluate(n.left),b=evaluate(n.right);if(a===null||b===null)return null;
    return n.op==="+"?a+b:n.op==="-"?a-b:n.op==="*"?a*b:b===0?null:a/b;
  }
  const value=evaluate(node);return value!==null&&Number.isFinite(value)?value:null;
}
export function compileReportFormulas(formulas:ReportFormula[] = [], fields:{id:string;type:string}[]) {
  return new Map<string, ReportFormula & ReturnType<typeof parseReportFormula>>(formulas.map(formula=>{
    const parsed=parseReportFormula(formula.expression);
    for(const id of parsed.fields)if(!fields.some(f=>f.id===id&&f.type==="number"))throw Error(`${formula.label}: [${id}] is not an available numeric property. Formula fields cannot reference other formulas.`);
    return [`formula:${formula.id}`,{...formula,...parsed}] as const;
  }));
}
