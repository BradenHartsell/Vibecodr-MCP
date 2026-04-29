import { pulseDescriptorDecisionRequirements } from "./pulseDescriptorMetadata.js";

type PromptArgument = {
  name: string;
  description: string;
  required?: boolean;
};

type PromptMessage = {
  role: "user" | "assistant";
  content: {
    type: "text";
    text: string;
  };
};

export type PromptDescriptor = {
  name: string;
  title: string;
  description: string;
  arguments?: PromptArgument[];
};

export type PromptResult = {
  description: string;
  messages: PromptMessage[];
};

type PromptBuilder = {
  descriptor: PromptDescriptor;
  build(args: Record<string, unknown>): PromptResult;
};

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildContextBlock(label: string, value?: string): string {
  return value ? `${label}: ${value}` : `${label}: not provided`;
}

const PROMPT_BUILDERS: PromptBuilder[] = [
  {
    descriptor: {
      name: "publish_creation_end_to_end",
      title: "Publish Creation End To End",
      description:
        "Guide the agent through the full Vibecodr publish flow: gather only missing launch details, confirm the write step, and close with a polished live-launch handoff.",
      arguments: [
        {
          name: "creation_summary",
          description: "Optional short summary of the app or file bundle the user wants to publish."
        },
        {
          name: "launch_goal",
          description: "Optional note about the desired launch outcome, audience, or vibe."
        }
      ]
    },
    build(args) {
      const creationSummary = readStringArg(args, "creation_summary");
      const launchGoal = readStringArg(args, "launch_goal");
      return {
        description:
          "Use Vibecodr's guided publish tools to take a creation from package to live vibe with minimal user effort and intentional launch polish.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "You are handling a Vibecodr publish flow from start to finish.",
                buildContextBlock("Creation summary", creationSummary),
                buildContextBlock("Launch goal", launchGoal),
                "",
                "Workflow requirements:",
                "- Treat this as guided publishing, not a handoff to the user.",
                "- If the user is connected, call get_account_capabilities before promising premium launch polish, custom SEO, private visibility, or pulse-backed behavior.",
                "- Infer title and entry file from the package when possible before asking the user anything.",
                "- Include payload.entry explicitly when the runnable file is obvious.",
                "- Ask only for information that is truly missing.",
                "- Default visibility to public unless the user explicitly wants unlisted or private.",
                "- If the launch has no obvious artwork, ask whether the user wants to add or generate a cover image.",
                "- If the user has a cover image or photo already, ask them to provide it before defaulting to generated art.",
                "- If the vibe is public, proactively ask whether they want SEO and social preview polish.",
                "- When suggesting SEO, recommend a clear launch title, a one- or two-sentence description, and a social preview line that explains what the vibe is and why someone should open it.",
                "- Before any action that makes the vibe live, ask for explicit confirmation in plain language.",
                "- Use quick_publish_creation by default for the actual launch unless the user asked for a slower manual flow.",
                "- After publish, return the live link, explain what people can now do with the vibe on Vibecodr, and suggest one high-value next step."
              ].join("\n")
            }
          }
        ]
      };
    }
  },
  {
    descriptor: {
      name: "polish_public_launch",
      title: "Polish Public Launch",
      description:
        "Coach the agent to improve a public Vibecodr launch with cover art, SEO, and social-share polish instead of a bare-minimum publish.",
      arguments: [
        {
          name: "project_summary",
          description: "Optional summary of the vibe or project being launched."
        },
        {
          name: "existing_title",
          description: "Optional title the user already has in mind."
        }
      ]
    },
    build(args) {
      const projectSummary = readStringArg(args, "project_summary");
      const existingTitle = readStringArg(args, "existing_title");
      return {
        description:
          "Guide the model to proactively offer launch polish for a public vibe, including cover image decisions and SEO/share-preview recommendations.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Help polish a public Vibecodr launch so it feels intentional and social-ready.",
                buildContextBlock("Project summary", projectSummary),
                buildContextBlock("Existing title", existingTitle),
                "",
                "Prompting requirements:",
                "- If the user is connected, check get_account_capabilities before promising custom SEO.",
                "- Ask whether the user already has a cover image, photo, or artwork they want to use.",
                "- If they do not, offer generated cover art and keep it landscape-oriented for feed cards and shared previews.",
                "- If they do have an image, prefer using that instead of forcing generated art.",
                "- Ask whether they want SEO and social preview polish for a public launch.",
                "- When giving SEO recommendations, suggest:",
                "  * a concise product-facing title,",
                "  * a description that says what the vibe does and why someone should click it,",
                "  * a social preview line that feels shareable rather than generic.",
                "- Keep the questions short and ask only for the missing launch-polish decisions."
              ].join("\n")
            }
          }
        ]
      };
    }
  },
  {
    descriptor: {
      name: "recover_publish_failure",
      title: "Recover Publish Failure",
      description:
        "Guide the agent to recover from a failed Vibecodr import or publish without dumping raw internal states on the user.",
      arguments: [
        {
          name: "failure_summary",
          description: "Optional plain-language summary of what failed."
        },
        {
          name: "operation_id",
          description: "Optional known operation id if the failure is already tied to one."
        }
      ]
    },
    build(args) {
      const failureSummary = readStringArg(args, "failure_summary");
      const operationId = readStringArg(args, "operation_id");
      return {
        description:
          "Keep the model in charge of the recovery flow: explain the failure in plain language, pick one concrete next step, and only use internals when needed.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Recover a Vibecodr publish flow that has failed or stalled.",
                buildContextBlock("Failure summary", failureSummary),
                buildContextBlock("Operation id", operationId),
                "",
                "Recovery requirements:",
                "- Lead with a plain-language explanation of what is blocked and why it matters.",
                "- Avoid dumping raw internal statuses unless the user explicitly asks for internals.",
                "- Prefer get_publish_readiness and get_runtime_readiness before deeper operation-inspection tools; call explain_operation_failure by exact name only for failure-specific recovery.",
                "- Use recovery internals only when the client explicitly exposes them or the user asks for low-level operation details.",
                "- Give one concrete next step instead of a menu of debugging options.",
                "- If a missing launch detail is the blocker, ask for that single missing detail and continue."
              ].join("\n")
            }
          }
        ]
      };
    }
  },
  {
    descriptor: {
      name: "decide_when_to_use_pulses",
      title: "Decide When To Use Pulses",
      description:
        "Guide the agent to decide whether a creation should stay frontend-only or needs Vibecodr pulses for trusted backend behavior.",
      arguments: [
        {
          name: "app_requirements",
          description: "Optional summary of the app's backend or integration needs."
        }
      ]
    },
    build(args) {
      const appRequirements = readStringArg(args, "app_requirements");
      return {
        description:
          "Use the repo's existing pulse guidance to keep frontend-only creations simple and escalate to pulses only when the product truly needs backend logic.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Decide whether this Vibecodr creation should stay frontend-only or use pulses.",
                buildContextBlock("App requirements", appRequirements),
                "",
                "Decision requirements:",
                ...pulseDescriptorDecisionRequirements().map((requirement) => `- ${requirement}`),
                "- Explain the recommendation in product language, not infrastructure jargon."
              ].join("\n")
            }
          }
        ]
      };
    }
  }
];

export function getPrompts(): PromptDescriptor[] {
  return PROMPT_BUILDERS.map((builder) => builder.descriptor);
}

export function getPrompt(name: string, args?: Record<string, unknown>): PromptResult | null {
  const builder = PROMPT_BUILDERS.find((item) => item.descriptor.name === name);
  if (!builder) return null;
  return builder.build(args || {});
}
