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
    expect(bubble.className).toContain("bg-[#0D0E12]/[0.58]");
    expect(bubble.className).toContain("backdrop-blur-xl");
    expect(bubble.className).toContain("border-white/[0.10]");
  });

  it("renders articulated part groups, dance/play/sleep/bonk/peeking animations, and cursor gazeX/gazeY", () => {
    const { container, rerender } = render(
      <CompanionSprite
        companionId="pixel_cat"
        emotion="dance"
        gazeX={0.8}
        gazeY={-0.4}
      />,
    );
    const sprite = screen.getByTestId("companion-sprite");
    expect(sprite).toHaveAttribute("data-emotion", "dance");
    expect(sprite.className).toContain("gl-anim-dance");
    expect(screen.getByTestId("companion-fx-dance")).toBeInTheDocument();
    expect(container.querySelector('[data-part="head"]')).not.toBeNull();
    expect(container.querySelector('[data-part="ears"]')).not.toBeNull();
    expect(container.querySelector('[data-part="tail"]')).not.toBeNull();
    expect(container.querySelector('[data-part="paws-left"]')).not.toBeNull();
    expect(container.querySelector('[data-part="paws-right"]')).not.toBeNull();

    const pupils = container.querySelector('[data-part="pupils"]');
    expect(pupils).toHaveAttribute("data-gaze-x", "0.80");
    expect(pupils).toHaveAttribute("data-gaze-y", "-0.40");

    // Clamping + live gaze tracking on Byte
    rerender(
      <CompanionSprite
        companionId="tech_nerd"
        emotion="play"
        gazeX={2.5}
        gazeY={-3}
      />,
    );
    expect(screen.getByTestId("companion-sprite")).toHaveAttribute("data-emotion", "play");
    expect(screen.getByTestId("companion-sprite").className).toContain("gl-anim-play");
    expect(screen.getByTestId("companion-fx-play")).toBeInTheDocument();
    expect(container.querySelector('[data-part="pupils"]')).toHaveAttribute("data-gaze-x", "1.00");
    expect(container.querySelector('[data-part="pupils"]')).toHaveAttribute("data-gaze-y", "-1.00");

    // Bonk articulates head bang downward
    rerender(<CompanionSprite companionId="pixel_cat" emotion="bonk" />);
    expect(container.querySelector('[data-part="head"]')?.getAttribute("class")).toContain("gl-head-bonk");
    expect(screen.getByTestId("companion-fx-bonk")).toBeInTheDocument();

    // Peeking renders rim-gripping paws
    rerender(<CompanionSprite companionId="pixel_cat" emotion="peeking" />);
    expect(screen.getByTestId("companion-peeking-paws")).toBeInTheDocument();

    // Sleep emotion on Sora
    rerender(<CompanionSprite companionId="anime_guide" emotion="sleep" />);
    expect(screen.getByTestId("companion-sprite").className).toContain("gl-anim-sleep");
    expect(screen.getByTestId("companion-fx-sleep")).toBeInTheDocument();
  });
});
