import BoardViewClient from "./BoardViewClient";

type MondayViewPageProps = {
  searchParams: {
    token?: string;
  };
};

export default function MondayViewPage({ searchParams }: MondayViewPageProps) {
  return (
    <main className="min-h-screen bg-background">
      <BoardViewClient token={searchParams.token ?? null} />
    </main>
  );
}
