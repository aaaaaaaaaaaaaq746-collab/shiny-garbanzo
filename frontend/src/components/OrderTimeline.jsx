import React from "react";
import { buildTimeline, statusBadge } from "../orderStatus";

/**
 * Horizontal progress timeline for a single order.
 *
 * Purely presentational: it reads the current status and renders the canonical
 * path. Cancelled/Rejected orders collapse to a single outcome chip.
 */
export default function OrderTimeline({ status, className = "" }) {
  const { steps, outcome } = buildTimeline(status);

  if (outcome) {
    return (
      <div className={`flex items-center gap-2 ${className}`} data-testid="order-timeline">
        <span className={`text-xs font-semibold px-3 py-1 rounded-full ${statusBadge(outcome)}`}>
          Order {outcome.toLowerCase()}
        </span>
      </div>
    );
  }

  return (
    <ol
      className={`flex items-center gap-1 sm:gap-2 ${className}`}
      data-testid="order-timeline"
      aria-label="Order progress"
    >
      {steps.map((step, i) => {
        const circle =
          step.state === "done"
            ? "bg-green-500 text-white"
            : step.state === "current"
            ? "bg-purple-600 text-white ring-2 ring-purple-300"
            : "bg-gray-200 text-gray-500";
        const label =
          step.state === "upcoming" ? "text-gray-400" : "text-gray-700 font-medium";

        return (
          <li key={step.status} className="flex items-center flex-1 last:flex-none">
            <span className="flex flex-col items-center gap-1">
              <span
                className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${circle}`}
                data-testid={`timeline-step-${step.status}`}
                data-state={step.state}
                aria-current={step.state === "current" ? "step" : undefined}
              >
                {i + 1}
              </span>
              <span className={`text-[10px] sm:text-xs whitespace-nowrap ${label}`}>
                {step.status}
              </span>
            </span>
            {i < steps.length - 1 && (
              <span
                className={`flex-1 h-0.5 mx-1 sm:mx-2 -mt-5 ${
                  step.state === "done" ? "bg-green-400" : "bg-gray-200"
                }`}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}