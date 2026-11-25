import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompanionSpeechBubble } from "../companions/CompanionSpeechBubble";
import { CompanionSprite } from "../companions/CompanionSprite";

describe("CompanionSprite and CompanionSpeechBubble", () => {
  it("renders SVG sprites for all 4 personas and returns null for none", () => {
    const { rerender } = render(
      <CompanionSprite companionId="pixel_cat" emotion="pointing" facing="right" size={48} />,
    );
    const sprite = screen.getByTestId("companion-sprite");
    expect(sprite).toHaveAttribute("data-companion", "pixel_cat");
    expect(sprite).toHaveAttribute("data-emotion", "pointing");
    expect(sprite).toHaveAttribute("data-facing", "right");
    expect(screen.getByTestId("companion-fx-pointing")).toBeInTheDocument();

    rerender(
      <CompanionSprite companionId="tech_nerd" emotion="typing" actionKind="type" />,
    );
    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-companion", "tech_nerd");
    expect(screen.getByTestId("companion-fx-typing")).toBeInTheDocument();

    rerender(<CompanionSprite companionId="anime_guide" emotion="bonk" />);
    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-companion", "anime_guide");
    expect(screen.getByTestId("companion-fx-bonk")).toBeInTheDocument();

    rerender(<CompanionSprite companionId="minimal_orb" emotion="celebrate" />);
    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-companion", "minimal_orb");
    expect(screen.getByTestId("companion-fx-celebrate")).toBeInTheDocument();

    rerender(<CompanionSprite companionId="none" />);
    expect(screen.queryByTestId("companion-sprite")).toBeNull();
  });

  it("renders CompanionSpeechBubble cleanly with badges and XSS-safe plain text", () => {
    render(
      <CompanionSpeechBubble
        companionId="anime_guide"
        text="Click Export <script>alert(1)</script>"
        shortcut="Ctrl+E"
        actionKind="click"
        stepLabel="1 / 3"
        screendayRecording
      />,
    );

    const bubble = screen.getByTestId("companion-speech-bubble");
    expect(bubble).toHaveTextContent("Sora");
    expect(bubble).toHaveTextContent("1 / 3");
    expect(bubble).toHaveTextContent("Click Export <script>alert(1)</script>");
    expect(bubble.querySelector("script")).toBeNull();
    expect(screen.getByTestId("companion-shortcut-badge")).toHaveTextContent("Ctrl+E");
    expect(screen.getByTestId("companion-action-badge")).toHaveTextContent("Click");
    expect(screen.getByTestId("companion-screenday-badge")).toHaveTextContent("Diary");
  });
});
