// Copy pinned Work App UI; only the documented browser host boundary is adapted.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
const source = resolve("../octo-work-app");
const target = resolve("packages/octo-runtime-extra-webui/web");
function copy(a, b) {
  mkdirSync(dirname(`${target}/${b}`), { recursive: true });
  cpSync(`${source}/${a}`, `${target}/${b}`, { recursive: true });
}
for (const name of ["ApprovalCards.tsx", "run-context.scss"])
  copy(`src/renderer/src/surfaces/${name}`, `src/surfaces/${name}`);
copy(
  "packages/ui-kit/src/react/ConversationComposer.tsx",
  "src/components/ConversationComposer.tsx"
);
const input = readFileSync(`${source}/src/shared/contracts.ts`, "utf8");
const ast = ts.createSourceFile("contracts.ts", input, ts.ScriptTarget.Latest, true);
const names = new Set([
  "ExecutionStatus",
  "TERMINAL_EXECUTION_STATUSES",
  "isTerminalStatus",
  "ExperienceEventType",
  "ExecutionEvent",
  "MessageRole",
  "MessageStatus",
  "ConversationMessage",
  "ConversationImagePart",
  "ConversationInputPart",
  "SendMessageResult"
]);
const statements = ast.statements.filter((node) =>
  names.has(node.name?.text ?? node.declarationList?.declarations[0]?.name?.text)
);
const contracts = statements
  .map((node) => node.getText(ast))
  .join("\n\n")
  .replace(
    "export interface ConversationImagePart {",
    "export interface ConversationImagePart {\n  dataUrl?: string"
  );
writeFileSync(
  `${target}/src/shared/contracts.ts`,
  contracts +
    `\nexport interface OwnerSubject {type:string;id:string}\nexport interface RuntimeAdapter {providerType:string;available:boolean;providerVersion?:string;unavailableReason?:string}\nexport interface ConversationDetail {summary:{agentId:string};messages:ConversationMessage[];executions?:SendMessageResult[]}\n`
);
const locale = `${target}/src/lib/i18n.ts`;
writeFileSync(locale, readFileSync(locale, "utf8").replace(/^  void window\.octoWork.*\n/m, ""));
const approvals = `${target}/src/surfaces/ApprovalCards.tsx`;
writeFileSync(
  approvals,
  readFileSync(approvals, "utf8").replace(
    "import type { RespondInteractionInput } from '@mininglamp-oss/octo-work-agent-access-kit/core'",
    "import type { InteractionResponse as RespondInteractionInput } from '@mininglamp-oss/octo-runtime-protocol'"
  )
);
const view = readFileSync(`${source}/src/renderer/src/surfaces/ConversationView.tsx`, "utf8");
const viewAst = ts.createSourceFile(
  "view.tsx",
  view,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const scroller = viewAst.statements
  .find((node) => node.name?.text === "TranscriptScroller")
  .getText(viewAst);
writeFileSync(
  `${target}/src/surfaces/TranscriptScroller.tsx`,
  `import {useRef,useState,useCallback,useLayoutEffect} from 'react'\nimport {AlertTriangle,ArrowDown} from 'lucide-react'\nimport {useT} from '@/lib/i18n'\nimport {Transcript} from './Transcript'\nimport type {OwnerSubject,ConversationMessage} from '@shared/contracts'\nimport type {MessageView} from '@shared/work-state'\nconst INITIAL_MESSAGES=40,PAGE_SIZE=40,NEAR_BOTTOM_PX=24\nexport ${scroller}\n`
);
