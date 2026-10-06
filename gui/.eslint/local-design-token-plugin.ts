import type { Rule } from "eslint";
import type { Literal, Property } from "estree";
import type { JSXAttribute } from "estree-jsx";

const HEX_IN_STRING = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const DEPAS_CLASS =
  /\bdepas-(?:view|app|nav|sheet|offline|main|topbar|brand|viewkop|viewsub)/;
const LEGACY_TOKEN = /--(?:wijn|gietijzer)(?:-[a-z0-9]+)*\b|\bsignaal-/i;
const INLINE_FONT_SIZE = /^\d+(?:\.\d+)?px$/;
const RAW_EASING =
  /cubic-bezier\(|(?<![\w-])ease(?:-in|-out|-in-out)?(?![\w-])/;

function literalValue(node: Literal): string | null {
  return typeof node.value === "string" ? node.value : null;
}

const noDepasDialect: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow De Pas / Signaal legacy class names and tokens.",
    },
    schema: [],
    messages: {
      depasClass:
        'Legacy design dialect "{{snippet}}" — use tokenized classes from styles.css (e.g. page-head, page-sub, traffic-*).',
      legacyToken:
        'Legacy design token reference "{{snippet}}" — use semantic OCX tokens (--red, --status-*, etc.).',
    },
  },
  create(context) {
    return {
      Literal(node: Literal) {
        const value = literalValue(node);
        if (!value) return;
        if (DEPAS_CLASS.test(value)) {
          context.report({
            node,
            messageId: "depasClass",
            data: { snippet: value.slice(0, 80) },
          });
        }
        if (LEGACY_TOKEN.test(value)) {
          context.report({
            node,
            messageId: "legacyToken",
            data: { snippet: value.slice(0, 80) },
          });
        }
      },
    };
  },
};

function isStyleProp(attr: JSXAttribute): boolean {
  return attr.name.type === "JSXIdentifier" && attr.name.name === "style";
}

function walkStyleObject(
  context: Rule.RuleContext,
  node: Property,
  messageId: "inlineHex" | "inlineFontSize" | "inlineEasing",
) {
  const key =
    node.key.type === "Identifier"
      ? node.key.name
      : node.key.type === "Literal" && typeof node.key.value === "string"
        ? node.key.value
        : null;
  const value = node.value;
  if (value.type !== "Literal" || typeof value.value !== "string") return;

  if (messageId === "inlineHex" && HEX_IN_STRING.test(value.value)) {
    context.report({
      node: value,
      messageId,
      data: { snippet: value.value.slice(0, 80) },
    });
  }
  if (
    messageId === "inlineFontSize" &&
    key === "fontSize" &&
    INLINE_FONT_SIZE.test(value.value.trim())
  ) {
    context.report({ node: value, messageId, data: { snippet: value.value } });
  }
  if (
    messageId === "inlineEasing" &&
    (key === "transition" ||
      key === "transitionTimingFunction" ||
      key === "animationTimingFunction") &&
    RAW_EASING.test(value.value) &&
    !value.value.includes("var(--ease")
  ) {
    context.report({
      node: value,
      messageId,
      data: { snippet: value.value.slice(0, 80) },
    });
  }
}

const noInlineVisualValues: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Discourage hard-coded colors, font sizes, and easing in inline styles.",
    },
    schema: [],
    messages: {
      inlineHex:
        'Inline hex color "{{snippet}}" — use var(--*) tokens or a CSS class.',
      inlineFontSize:
        'Inline fontSize "{{snippet}}" — use .text-* utility or var(--text-*).',
      inlineEasing:
        'Inline easing "{{snippet}}" — use var(--ease-out) or var(--motion-*).',
    },
  },
  create(context) {
    return {
      JSXAttribute(node: JSXAttribute) {
        if (
          !isStyleProp(node) ||
          !node.value ||
          node.value.type !== "JSXExpressionContainer"
        )
          return;
        const expr = node.value.expression;
        if (expr.type !== "ObjectExpression") return;
        for (const prop of expr.properties) {
          if (prop.type !== "Property") continue;
          walkStyleObject(context, prop, "inlineHex");
          walkStyleObject(context, prop, "inlineFontSize");
          walkStyleObject(context, prop, "inlineEasing");
        }
      },
    };
  },
};

export default {
  rules: {
    "no-depas-dialect": noDepasDialect,
    "no-inline-visual-values": noInlineVisualValues,
  },
};
