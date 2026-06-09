import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CardViewer } from "../components/CardViewer";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import {
  fetchPayDetails,
  PayLinkExpiredError,
  PayLinkNotFoundError,
  type PayDetails,
} from "../api/pay";
import { formatCents } from "../utils/money";

/**
 * Vendor-facing payment page. Public — no auth context, no nav bar. The route
 * is registered in `App.tsx` with no auth guard and the matching backend
 * endpoint (`GET /api/pay/:slug`) opts out of the JWT hook via
 * `config: { public: true }`.
 *
 * The slug from the URL is the rotating secret; everything sensitive flows
 * through it. We deliberately keep the layout minimal — a vendor lands here
 * from an email, sees the amount + payee, and types the masked card details
 * into their checkout form.
 */
export function PayByLinkPage() {
  const { slug } = useParams<{ slug: string }>();

  if (!slug) {
    return <PayPageShell>{<LinkInactiveMessage />}</PayPageShell>;
  }

  return <PayByLinkContent slug={slug} />;
}

interface PayByLinkContentProps {
  slug: string;
}

function PayByLinkContent({ slug }: PayByLinkContentProps) {
  const payQuery = useQuery({
    queryKey: ["pay-by-link", slug],
    queryFn: () => fetchPayDetails(slug),
    // 404/410 are terminal — retrying just delays the friendly message.
    retry: (failureCount, err) => {
      if (
        err instanceof PayLinkExpiredError ||
        err instanceof PayLinkNotFoundError
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });

  if (payQuery.isPending) {
    return (
      <PayPageShell>
        <LoadingSpinner message="Loading payment details..." />
      </PayPageShell>
    );
  }

  if (payQuery.isError) {
    const err = payQuery.error;
    if (
      err instanceof PayLinkExpiredError ||
      err instanceof PayLinkNotFoundError
    ) {
      return (
        <PayPageShell>
          <LinkInactiveMessage />
        </PayPageShell>
      );
    }
    return (
      <PayPageShell>
        <div className="space-y-4">
          <ErrorMessage message="Something went wrong loading this payment link. Please try again." />
          <button
            type="button"
            onClick={() => void payQuery.refetch()}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Retry
          </button>
        </div>
      </PayPageShell>
    );
  }

  return (
    <PayPageShell>
      <PayDetailsView details={payQuery.data} />
    </PayPageShell>
  );
}

interface PayPageShellProps {
  children: React.ReactNode;
}

function PayPageShell({ children }: PayPageShellProps) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-gradient-to-br from-indigo-50 via-white to-slate-100 px-4 py-10 sm:py-16">
      <div className="w-full max-w-md">
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <header className="mb-6 text-center">
            <div className="flex items-center justify-center gap-2">
              <img
                src="/favicon.svg"
                alt="AP Automation"
                className="h-7 w-7"
              />
              <h1 className="text-2xl font-extrabold tracking-tight text-indigo-600">
                AP Automation
              </h1>
            </div>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-400">
              Payment link
            </p>
            <div className="mx-auto mt-3 h-px w-16 bg-indigo-200" />
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}

function LinkInactiveMessage() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-center text-sm text-amber-900">
      This payment link is no longer active. Please contact the sender for a
      new link.
    </div>
  );
}

interface PayDetailsViewProps {
  details: PayDetails;
}

function PayDetailsView({ details }: PayDetailsViewProps) {
  const { vendorName, amountCents, currencyCode, invoiceNumber, clientToken, cardId } =
    details;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-5 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-indigo-700">
          Pay invoice {invoiceNumber} to
        </p>
        <p className="mt-1 text-base font-semibold text-gray-900">
          {vendorName}
        </p>
        <p className="mt-3 text-3xl font-bold tracking-tight text-indigo-900">
          {formatCents(amountCents, currencyCode)}
        </p>
      </section>

      <CardViewer
        invoiceId={`pay-${invoiceNumber}`}
        paymentCardId={cardId}
        clientTokenValue={clientToken}
      />

      <p className="text-xs leading-relaxed text-gray-500">
        This is a single-use virtual card. It can only be charged once for the
        exact amount above. You're paying {vendorName} directly; the link
        expires in 24 hours.
      </p>
    </div>
  );
}
