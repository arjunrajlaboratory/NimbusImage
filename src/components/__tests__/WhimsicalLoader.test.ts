import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import WhimsicalLoader from "@/components/WhimsicalLoader.vue";

describe("WhimsicalLoader", () => {
  describe("sm size", () => {
    it("renders an animation from the full set", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.find(".whimsical-loader--sm").exists()).toBe(true);
      const animDiv = wrapper.find(".whimsical-loader__animation");
      const validAnimations = [
        "animation-bouncing-molecules",
        "animation-newtons-cradle",
      ];
      const hasValidAnimation = validAnimations.some((cls) =>
        animDiv.classes().includes(cls),
      );
      expect(hasValidAnimation).toBe(true);
    });

    it("does not render text", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.find(".whimsical-loader__text").exists()).toBe(false);
    });

    it("does not render text even with text prop", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "sm", text: "Loading..." },
      });
      expect(wrapper.find(".whimsical-loader__text").exists()).toBe(false);
    });
  });

  describe("accessibility", () => {
    it("has role=status and aria-label", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.attributes("role")).toBe("status");
      expect(wrapper.attributes("aria-label")).toBe("Loading");
    });
  });

  describe("color prop", () => {
    it("applies light color class when color=light", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "sm", color: "light" },
      });
      expect(wrapper.classes()).toContain("whimsical-loader--color-light");
    });

    it("applies dark color class when color=dark", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "md", color: "dark" },
      });
      expect(wrapper.classes()).toContain("whimsical-loader--color-dark");
    });

    it("does not apply color class when color=auto", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "sm" } });
      expect(wrapper.classes()).not.toContain("whimsical-loader--color-light");
      expect(wrapper.classes()).not.toContain("whimsical-loader--color-dark");
    });
  });

  describe("md size", () => {
    it("renders at md size with an animation from the full set", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "md" } });
      expect(wrapper.find(".whimsical-loader--md").exists()).toBe(true);
      const animDiv = wrapper.find(".whimsical-loader__animation");
      const validAnimations = [
        "animation-bouncing-molecules",
        "animation-newtons-cradle",
      ];
      const hasValidAnimation = validAnimations.some((cls) =>
        animDiv.classes().includes(cls),
      );
      expect(hasValidAnimation).toBe(true);
    });

    it("does not render text by default", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "md" } });
      expect(wrapper.find(".whimsical-loader__text").exists()).toBe(false);
    });

    it("renders text when text prop is provided", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "md", text: "Processing..." },
      });
      expect(wrapper.find(".whimsical-loader__text").text()).toBe(
        "Processing...",
      );
    });
  });

  describe("lg size", () => {
    it("renders at lg size with a fun message", () => {
      const wrapper = mount(WhimsicalLoader, { props: { size: "lg" } });
      expect(wrapper.find(".whimsical-loader--lg").exists()).toBe(true);
      expect(wrapper.find(".whimsical-loader__text").exists()).toBe(true);
      expect(wrapper.find(".whimsical-loader__text").text().length).toBeGreaterThan(0);
    });

    it("uses text prop over random message when provided", () => {
      const wrapper = mount(WhimsicalLoader, {
        props: { size: "lg", text: "Custom loading text" },
      });
      expect(wrapper.find(".whimsical-loader__text").text()).toBe(
        "Custom loading text",
      );
    });
  });

  describe("default size", () => {
    it("defaults to md when no size prop", () => {
      const wrapper = mount(WhimsicalLoader);
      expect(wrapper.find(".whimsical-loader--md").exists()).toBe(true);
    });
  });
});
