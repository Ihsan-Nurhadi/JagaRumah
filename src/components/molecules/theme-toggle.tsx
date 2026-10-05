"use client";

import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react/dist/ssr";
import { useTheme } from "next-themes";

import { Button } from "@/components/atoms";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMounted } from "@/lib/use-mounted";

const options = [
  { value: "light", label: "Terang", Icon: SunIcon },
  { value: "dark", label: "Gelap", Icon: MoonIcon },
  { value: "system", label: "Ikut sistem", Icon: DesktopIcon },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  /*
    Tema belum diketahui di server. Daripada merender tombol mati sementara,
    ruang yang sama diisi penanda kosong sampai tema terbaca di klien.
  */
  if (!mounted) {
    return <div aria-hidden className="size-11 sm:size-9" />;
  }

  const current = options.find((option) => option.value === theme) ?? options[2];
  const CurrentIcon = current.Icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Tema: ${current.label}`}>
          <CurrentIcon aria-hidden weight="regular" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {options.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden weight="regular" className="size-4" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
