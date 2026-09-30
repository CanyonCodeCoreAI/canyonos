import { createFileRoute, redirect } from '@tanstack/react-router';

// The authenticated home is the Projects Overview, which lives at /projects.
export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: () => {
    throw redirect({ to: '/projects' });
  },
});
