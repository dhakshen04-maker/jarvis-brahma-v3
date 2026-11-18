import { AppShell } from "@/components/AppShell";
import { BrahmaProvider } from "@/components/BrahmaProvider";

export default function HomePage() {
  return (
    <BrahmaProvider>
      <AppShell />
    </BrahmaProvider>
  );
}
