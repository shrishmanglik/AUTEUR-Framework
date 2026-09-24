import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FRAMEWORKS,
  ContentFormatSchema,
  UniversalPacketSchema,
  ContinuationInputSchema,
  SpokenClipPlanInputSchema,
  PostProductionPlanSchema,
  buildProductionKit,
  assessShotRoute,
  buildRepairPrompt,
  buildStoryboard,
  buildDevelopmentContract,
  compilePacket,
  compileCompactVideoPrompt,
  compileCompactVideoPromptWithReport,
  compileFrameworkVideoPrompt,
  compileShot,
  depthOfFieldCharacter,
  preflightPacket,
} from "../src/index.js";

const example = JSON.parse(fs.readFileSync(new URL("../examples/product-film.json", import.meta.url), "utf8"));

function classifyRootExample(input: unknown) {
  const packet = UniversalPacketSchema.safeParse(input);
  // Companion parsing must not discard malformed packet fields and skip kit validation.
  const companions = [ContinuationInputSchema, SpokenClipPlanInputSchema, PostProductionPlanSchema]
    .filter((schema) => schema.strict().safeParse(input).success);
  if (Number(packet.success) + companions.length !== 1) {
    throw new Error("Example must match exactly one supported packet or companion contract schema");
  }
  return packet.success ? packet.data : null;
}

describe("published example coverage", () => {
  it("validates every root JSON example and preflights every discovered packet", () => {
    const examplesUrl = new URL("../examples/", import.meta.url);
    const files = fs.readdirSync(examplesUrl, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name).sort();
    expect(files.length).toBeGreaterThan(0);
    const exercised: string[] = [];
    for (const filename of files) {
      const input = JSON.parse(fs.readFileSync(new URL(filename, examplesUrl), "utf8"));
      const packet = classifyRootExample(input);
      if (!packet) continue;
      const kit = buildProductionKit(packet);
      expect(kit.preflight.passed, `${filename}: ${JSON.stringify(kit.preflight.issues)}`).toBe(true);
      const frameworks = [...new Set(packet.shots.map((shot) => shot.frameworkId))].sort();
      exercised.push(`[${filename}](examples/${filename}) (${frameworks.map((id) => `\`${id}\``).join(", ")})`);
    }
    expect(exercised.length).toBeGreaterThan(0);
    const inventory = `Executable packet-to-kit fixtures (${exercised.length}): ${exercised.join(", ")}.`;
    console.info(`AUTEUR_PACKET_FIXTURES: ${inventory}`);
    console.info(`AUTEUR_EXAMPLE_COUNTS: ${files.length} root JSON; ${exercised.length} packets; ${files.length - exercised.length} companion contracts`);
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`<!-- packet-fixtures:start -->\n${inventory}\n<!-- packet-fixtures:end -->`);
  });

  it("rejects unknown and malformed examples instead of skipping them", () => {
    expect(() => classifyRootExample({ unknown: true })).toThrow("exactly one");
    const malformed = structuredClone(example);
    malformed.shots[0].durationSeconds = -1;
    expect(() => classifyRootExample(malformed)).toThrow("exactly one");
  });

  it("detects a structural preflight error in an otherwise valid packet", () => {
    const invalidTiming = structuredClone(example);
    invalidTiming.metadata.targetDurationSeconds += 1;
    const packet = classifyRootExample(invalidTiming);
    expect(packet).not.toBeNull();
    const kit = buildProductionKit(packet!);
    expect(kit.preflight.passed).toBe(false);
    expect(kit.preflight.issues).toContainEqual(expect.objectContaining({ code: "PRODUCTION_DURATION_MISMATCH" }));
  });

  it.each([
    ["continuation.json", ContinuationInputSchema],
    ["spoken-clip-plan.json", SpokenClipPlanInputSchema],
    ["post-production-plan.json", PostProductionPlanSchema],
  ] as const)("rejects malformed packets carrying valid %s fields", (filename, schema) => {
    const companion = JSON.parse(fs.readFileSync(new URL(`../examples/${filename}`, import.meta.url), "utf8"));
    expect(classifyRootExample(companion)).toBeNull();
    const malformed = { ...structuredClone(example), ...companion };
    malformed.shots[0].durationSeconds = -1;
    expect(UniversalPacketSchema.safeParse(malformed).success).toBe(false);
    // The permissive parser accepts this mixed shape by discarding packet fields.
    expect(schema.safeParse(malformed).success).toBe(true);
    expect(() => classifyRootExample(malformed)).toThrow("exactly one");
  });
});

describe("universal packet", () => {
  it("parses the synthetic product-film example", () => {
    const packet = UniversalPacketSchema.parse(example);
    expect(packet.shots).toHaveLength(1);
    expect(packet.shots[0]?.camera.capture).toEqual({});
  });

  it("rejects an impossible projected-subject scale lock", () => {
    const packet = structuredClone(example);
    packet.shots[0].camera.compositionLock = {
      maxProjectedSubjectScaleChangePercent: 101,
      protectedFrameElements: ["full facade"],
      forbidDigitalZoom: true,
    };
    expect(() => UniversalPacketSchema.parse(packet)).toThrow();
  });

  it("projects a measurable composition lock into the video prompt", () => {
    const packet = structuredClone(example);
    packet.shots[0].frameworkId = "cinematic-prose-stack";
    packet.shots[0].camera.compositionLock = {
      maxProjectedSubjectScaleChangePercent: 5,
      protectedFrameElements: ["right architectural wing", "full pool", "wet grass foreground"],
      forbidDigitalZoom: true,
    };
    const prompt = compilePacket(packet).shots[0]!.videoPrompt;
    expect(prompt).toContain("width and height may change by no more than 5 percent");
    expect(prompt).toContain("right architectural wing");
    expect(prompt).toContain("no digital zoom, hidden cut, focal-length substitution, or reframing jump");
  });

  it("ships a distinct provider-neutral framework registry", () => {
    expect(FRAMEWORKS.length).toBeGreaterThanOrEqual(9);
    expect(new Set(FRAMEWORKS.map((item) => item.id)).size).toBe(FRAMEWORKS.length);
  });

  it("keeps published JSON schemas aligned with spoken timing windows", () => {
    for (const filename of ["universal-packet.schema.json", "continuation-input.schema.json"]) {
      const schema = fs.readFileSync(new URL(`../schemas/${filename}`, import.meta.url), "utf8");
      expect(schema, filename).toContain('"spokenWindow"');
      expect(schema, filename).toContain('"additionalProperties": false');
    }
  });

  it("keeps defaulted performance controls optional in published input schemas", () => {
    const universal = JSON.parse(fs.readFileSync(
      new URL("../schemas/universal-packet.schema.json", import.meta.url),
      "utf8",
    ));
    const continuation = JSON.parse(fs.readFileSync(
      new URL("../schemas/continuation-input.schema.json", import.meta.url),
      "utf8",
    ));

    expect(universal.properties.shots.items.properties.performance).toBeTypeOf("object");
    expect(universal.properties.shots.items.required).not.toContain("performance");
    expect(continuation.properties.shot.properties.performance).toBeTypeOf("object");
    expect(continuation.properties.shot.required).not.toContain("performance");
    expect(UniversalPacketSchema.parse(example).shots[0]?.performance).toEqual({});
  });
});

describe("development contract", () => {
  it("routes a raw short-film idea into a schema-bound act/shot contract", () => {
    const contract = buildDevelopmentContract({
      idea: "A night-shift cleaner finds one office elevator stopping at a floor that does not exist.",
      format: "short-film",
      targetDurationSeconds: 90,
      aspectRatio: "2.39:1",
      audience: "adult suspense viewers",
      tone: ["dry", "uneasy", "human"],
      constraints: ["one actor", "one location"],
      hasDialogue: true,
      requiresTransformation: false,
      audioRequired: true,
    });
    expect(contract.framework.id).toBe("act-shot-master-spec");
    expect(contract.systemInstruction).toContain("Return only data");
    expect(contract.responseSchema).toBeTypeOf("object");
  });

  it("routes transformation work to temporal evolution", () => {
    const contract = buildDevelopmentContract({
      idea: "A paper city folds itself into a working mechanical clock in one unbroken view.",
      format: "vfx",
      targetDurationSeconds: 12,
      aspectRatio: "16:9",
      audience: "design and motion audiences",
      tone: ["precise", "tactile"],
      requiresTransformation: true,
    });
    expect(contract.framework.id).toBe("temporal-evolution");
  });

  it("routes explicit production problems to their native framework architectures", () => {
    const base = {
      idea: "An original production problem with one observable action and a measurable final state.",
      format: "other" as const,
      targetDurationSeconds: 8,
      aspectRatio: "16:9" as const,
      audience: "professional filmmakers",
      tone: ["specific", "physical"],
    };
    expect(buildDevelopmentContract({ ...base, requiresPracticalChoreography: true }).framework.id)
      .toBe("practical-stunt-contract");
    expect(buildDevelopmentContract({ ...base, requiresMachineReadableSceneContract: true }).framework.id)
      .toBe("json-scene-contract");
    expect(buildDevelopmentContract({ ...base, audioFirst: true }).framework.id)
      .toBe("audio-contract");
  });

  it("builds a development contract for every public content format", () => {
    const expectedRoutes = {
      "short-film": "act-shot-master-spec",
      ad: "cinematic-prose-stack",
      reel: "timed-social-sequence",
      "a-roll": "avatar-a-roll-json",
      "b-roll": "cinematic-prose-stack",
      "music-video": "act-shot-master-spec",
      "product-film": "cinematic-prose-stack",
      "character-scene": "continuous-take",
      vfx: "temporal-evolution",
      animation: "cinematic-prose-stack",
      image: "cinematic-prose-stack",
      sequence: "act-shot-master-spec",
      other: "cinematic-prose-stack",
    } as const;
    for (const format of ContentFormatSchema.options) {
      const contract = buildDevelopmentContract({
        idea: `An original ${format} concept with one observable action and an earned final state.`,
        format,
        targetDurationSeconds: 24,
        aspectRatio: "16:9",
        audience: "general creative audience",
        tone: ["specific", "human"],
      });
      expect(contract.request.format).toBe(format);
      expect(contract.framework.id).toBe(expectedRoutes[format]);
      expect(contract.responseSchema).toBeTypeOf("object");
    }
  });
});

describe("compiler", () => {
  it("puts optics before movement and emits all generation surfaces", () => {
    const shot = UniversalPacketSchema.parse(example).shots[0]!;
    const compiled = compileShot(shot);
    expect(compiled.videoPrompt.indexOf("100mm")).toBeLessThan(compiled.videoPrompt.indexOf("slider"));
    expect(compiled.promptFidelity).toBe("FRAMEWORK_NATIVE");
    expect(compiled.frameworkName).toBe("Cinematic Prose Stack");
    expect(compiled.compactVideoPrompt).toContain("[0-2s]");
    expect(compiled.compactVideoPrompt).toContain("100mm");
    expect(compiled.compactVideoPrompt).toContain("PREMISE:");
    expect(compiled.compactVideoPrompt).toContain("REALITY ANCHOR:");
    expect(compiled.compactVideoPrompt).toContain("OPTICS AND CAMERA:");
    expect(compiled.compactVideoPrompt).toContain("SEQUENCE:");
    expect(compiled.compactVideoPrompt).toContain("EXPRESSION AND EXCLUSIONS:");
    expect(compiled.compactVideoPrompt).toContain("no identity drift");
    expect(compiled.compactPromptReport.frameworkPreserved).toBe(true);
    expect(compiled.frameStateSources.opening).toBe("minimal-fallback");
    expect(compiled.terminalFramePrompt).toContain("tiny trapped bubbles");
    expect(compiled.framePrompt).toContain("Reference surface lock:");
    expect(compiled.framePrompt).toContain("otherwise it remains plain and unbranded");
    expect(compiled.framePrompt).not.toContain("No glyph, letter, number");
    expect(compiled.audioPrompt).toContain("liquid pour");
    expect(compiled.negativePrompt).toContain("no identity drift");
  });

  it("separates opening and terminal frame contracts for multi-stage reference routes", () => {
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    shot.generationRisks = ["IDENTITY_OR_PERFORMANCE"];
    shot.subject = "one professional diver with one handheld lamp";
    shot.environment = "cold green water, broken timber ribs, and one bronze bell attached to a beam";
    shot.materials = ["waterlogged timber", "oxidized bronze", "black drysuit fabric"];
    shot.imperfectionAnchors = ["uneven silt", "biofouling on the bell edge"];
    shot.continuityLocks = ["same diver gear", "bell stays attached to the beam"];
    shot.beats = [
      { startSeconds: 0, endSeconds: 2, action: "the diver enters through a narrow timber gap" },
      { startSeconds: 2, endSeconds: 6, action: "the lamp sweeps once across waterlogged timber" },
      { startSeconds: 6, endSeconds: 8, action: "the lamp reveals the bronze bell and the diver stops" },
    ];
    shot.frameStates = {
      opening: {
        subject: "one professional diver with one handheld lamp",
        action: "the diver has just entered through a narrow timber gap",
        environment: "cold green water with suspended silt and occluding timber ribs",
        visibleInventory: ["one diver", "one right-hand lamp", "two plain tanks", "one timber gap"],
        lighting: "the handheld lamp rakes across near timber",
        paletteBase: ["cold green", "weathered timber", "black neoprene", "plain steel"],
        materials: ["waterlogged timber", "black drysuit fabric", "plain brushed metal tanks"],
        imperfectionAnchors: ["tiny scratches on mask glass", "uneven silt density"],
        continuityLocks: ["same diver gear and tank layout", "one lamp remains in the right hand"],
      },
      terminal: {
        subject: "the same professional diver with the same handheld lamp",
        action: "the lamp reveals the bronze bell and the diver stops",
        environment: "cold green water beside one bronze bell attached to a wreck beam",
        visibleInventory: ["one diver", "one right-hand lamp", "one attached bronze bell"],
        lighting: "the handheld lamp lands on the bronze bell",
        paletteBase: ["cold green", "aged bronze", "black neoprene"],
        materials: ["waterlogged timber", "oxidized bronze", "black drysuit fabric"],
        imperfectionAnchors: ["tiny scratches on mask glass", "biofouling on the bell edge"],
        continuityLocks: ["same diver gear and tank layout", "bell stays attached to the beam"],
      },
    };
    const compiled = compileShot(shot);
    const route = assessShotRoute(shot);

    expect(compiled.framePrompt).toBe(compiled.openingFramePrompt);
    expect(compiled.openingFramePrompt).toContain("OPENING STATE (0.0s):");
    expect(compiled.openingFramePrompt).toContain("the diver has just entered through a narrow timber gap");
    expect(compiled.openingFramePrompt).not.toMatch(/bell/i);
    expect(compiled.openingFramePrompt).not.toMatch(/bronze/i);
    expect(compiled.openingFramePrompt).toContain("assigned to a later beat remains outside frame");
    expect(compiled.terminalFramePrompt).toContain("TERMINAL STATE (8s):");
    expect(compiled.terminalFramePrompt).toContain("the lamp reveals the bronze bell");
    expect(compiled.terminalFramePrompt).toContain("Endpoint match lock:");
    expect(compiled.terminalFramePrompt).toContain("change only the declared terminal state");
    expect(compiled.frameStateSources).toEqual({ opening: "explicit", terminal: "explicit" });
    expect(route.recommendedMode).toBe("split-pass");
    expect(route.risks).toContainEqual(expect.objectContaining({ code: "DELAYED_TERMINAL_REVEAL" }));
    expect(route.requiredAssets).toContain("accepted pre-reveal final frame for render-observed continuation compilation");
    expect(route.acceptanceChecks).toContain("Reject a pre-reveal pass whose prompt or pixels expose terminal-only inventory.");
  });

  it("labels a safe minimal opening fallback instead of copying composite scene fields", () => {
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    shot.generationRisks = ["IDENTITY_OR_PERFORMANCE"];
    shot.environment = "a workshop where the final engraved trophy is already visible";
    shot.materials = ["engraved trophy metal"];
    shot.continuityLocks = ["trophy remains on the table", "same craftsperson identity"];
    const compiled = compileShot(shot);

    expect(compiled.frameStateSources.opening).toBe("minimal-fallback");
    expect(compiled.openingFramePrompt).not.toContain("final engraved trophy");
    expect(compiled.openingFramePrompt).not.toContain("trophy remains on the table");
    expect(compiled.qcIssues).toContainEqual(expect.objectContaining({ code: "OPENING_FRAME_STATE_FALLBACK" }));
  });

  it("compiles genuinely distinct corpus architectures instead of relabeling one template", () => {
    const baseShot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    const expectedSignatures = {
      "cinematic-prose-stack": "PREMISE:",
      "act-shot-master-spec": "TECHNICAL MASTER SPECIFICATIONS:",
      "json-scene-contract": "\"metadata\"",
      "avatar-a-roll-json": "\"project_manifest\"",
      "temporal-evolution": "INITIAL STATE (0.0s):",
      "timed-social-sequence": "HOOK (FIRST 2 SECONDS):",
      "practical-stunt-contract": "CONTINUOUS CAMERA MOVE (8000ms):",
      "continuous-take": "A single unbroken 8-second take",
      "audio-contract": "PRIMARY SOURCE AND PERFORMANCE:",
    } as const;
    const prompts = Object.entries(expectedSignatures).map(([frameworkId, signature]) => {
      const shot = structuredClone(baseShot);
      shot.frameworkId = frameworkId;
      if (frameworkId === "practical-stunt-contract") {
        shot.camera.capture = {
          sensorFormat: "Super 35 digital cinema sensor",
          recordingFormat: "log acquisition",
          rig: "low tracking vehicle rig",
          frameRateFps: 24,
          shutterAngleDegrees: 180,
          resolutionIntent: "4K finish",
        };
      }
      const compiled = compileShot(shot, example.globalExclusions, example.globalStyle, {
        aspectRatio: "16:9",
        audience: "filmmakers",
        contentFormat: "product-film",
        productionTitle: "Architecture fidelity test",
        shotCount: 1,
        shotIndex: 0,
      });
      expect(compiled.videoPrompt, frameworkId).toContain(signature);
      expect(compiled.videoPrompt, frameworkId).toContain("Temporal boundary rule:");
      expect(compiled.compactVideoPrompt, frameworkId).toContain(signature);
      expect(compiled.frameworkArchitecture.length, frameworkId).toBeGreaterThanOrEqual(5);
      expect(compiled.compactPromptReport.frameworkPreserved).toBe(true);
      if (frameworkId === "practical-stunt-contract") {
        expect(compiled.videoPrompt).toContain("24fps");
        expect(compiled.videoPrompt).toContain("180-degree shutter");
      }
      return compiled.videoPrompt;
    });
    expect(new Set(prompts).size).toBe(Object.keys(expectedSignatures).length);
  });

  it("fails closed when evidence-specific frameworks are used through the generic shot compiler", () => {
    const baseShot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    const repairShot = structuredClone(baseShot);
    repairShot.frameworkId = "repair-pass";
    expect(() => compileShot(repairShot)).toThrow("use buildRepairPrompt");

    const continuationShot = structuredClone(baseShot);
    continuationShot.frameworkId = "render-observed-continuation";
    expect(() => compileShot(continuationShot)).toThrow("use compileContinuationPrompt");
  });

  it("keeps composition locks structured in JSON scene contracts", () => {
    const packet = structuredClone(example);
    packet.shots[0].frameworkId = "json-scene-contract";
    packet.shots[0].camera.compositionLock = {
      maxProjectedSubjectScaleChangePercent: 4,
      protectedFrameElements: ["full face", "both shoulders", "background practical"],
      forbidDigitalZoom: true,
    };

    const withLock = JSON.parse(compilePacket(packet).shots[0]!.videoPrompt);
    expect(withLock.camera.composition_lock).toEqual({
      max_projected_subject_scale_change_percent: 4,
      protected_frame_elements: ["full face", "both shoulders", "background practical"],
      forbid_digital_zoom: true,
    });

    delete packet.shots[0].camera.compositionLock;
    const withoutLock = JSON.parse(compilePacket(packet).shots[0]!.videoPrompt);
    expect(withoutLock.camera).not.toHaveProperty("composition_lock");
  });

  it("emits exact dialogue once even when action and beat text repeat it", () => {
    for (const frameworkId of ["avatar-a-roll-json", "continuous-take", "audio-contract"]) {
      const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
      shot.frameworkId = frameworkId;
      shot.dialogue = "Hold the frame.";
      shot.audioTrack.spokenText = "Hold the frame.";
      shot.audioTrack.spokenWindow = { startSeconds: 6, endSeconds: 8 };
      shot.action = "the craftsperson says Hold the frame. and steadies the glass";
      shot.beats[2]!.action = "the craftsperson says Hold the frame. while the liquid settles";
      const compiled = compileShot(shot);
      expect(compiled.videoPrompt.match(/Hold the frame\./g), frameworkId).toHaveLength(1);
      expect(compiled.videoPrompt, frameworkId).toContain("do not begin articulation before 6s");
      expect(compiled.audioPrompt, frameworkId).toContain("Spoken timing: 6-8s");
    }
  });

  it("compiles A-roll as a corpus-native JSON triple-lock contract", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const compiled = compileShot(packet.shots[0]!, packet.globalExclusions, packet.globalStyle, {
      aspectRatio: packet.metadata.aspectRatio,
      contentFormat: packet.metadata.format,
      productionTitle: packet.metadata.title,
      sceneTitle: packet.scenes[0]!.title,
    });
    const manifest = JSON.parse(compiled.videoPrompt).project_manifest;
    const compactManifest = JSON.parse(compiled.compactVideoPrompt).project_manifest;

    expect(compiled.frameworkId).toBe("avatar-a-roll-json");
    expect(manifest.manifest_version).toContain("A-Roll JSON");
    expect(manifest.layer_iii_character_and_asset_bible.vocal_signature_lock.pace_wpm).toBe(150);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.facial_constraints.head_movement_max_degrees).toBe(3);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["4_audio_and_sensory_sync"]
      .locked_audio_profile.phoneme_alignment.acceptance_target_ms).toBe(20);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["4_audio_and_sensory_sync"]
      .locked_audio_profile.phoneme_alignment.confidence_min).toBe(0.99);
    expect(manifest.layer_i_global_creative_directive.render_specifications.freeze_pad_frames_at_end).toBe(3);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.terminal_hold.freeze_pad_frames_at_end).toBe(3);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.terminal_hold.minimum_settle_seconds).toBe(0.75);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.terminal_hold.forbidden_during_boundary_lock).toContain(
      "mouth reopening or silent mouthing",
    );
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.terminal_hold.boundary_lock_seconds).toBe(0.25);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.terminal_hold.boundary_lock_window_seconds).toEqual([29.75, 30]);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.terminal_hold.natural_settle_state).toContain("one natural blink");
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.natural_kinetics.gesture_bounds.amplitudeDegreesMax).toBe(7);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.natural_kinetics.head_motion.nodsMax).toBe(1);
    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.natural_kinetics.body_motion.breathsPerMinute).toBe(12);
    expect(manifest.layer_vi_ai_model_constraints.triple_lock_protocol.script_lock.rule).toContain("verbatim once");
    expect(compactManifest.manifest_version).toBe(manifest.manifest_version);
    expect(compactManifest.scene_blueprint.audio_vocal_lock.lip_sync_confidence_min).toBe(0.99);
    expect(compactManifest.scene_blueprint.audio_vocal_lock.mix.integratedLufs).toBe(-14);
    expect(compactManifest.scene_blueprint.audio_vocal_lock.mix.truePeakDbfsMax).toBe(-1);
    expect(compactManifest.character_asset_bible.vocal_lock.accent).toContain("South Asian English");
    expect(compactManifest.character_asset_bible.vocal_lock.voice_profile_id)
      .toBe("approved-founder-voice-reference");
    expect(compactManifest.character_asset_bible.vocal_lock.base_pitch_hz).toBe(110);
    expect(compactManifest.character_asset_bible.vocal_lock.pitch_range_hz).toEqual({ min: 90, max: 165 });
    expect(compactManifest.character_asset_bible.vocal_lock.speech_rate_tolerance_percent).toBe(8);
    expect(compactManifest.character_asset_bible.vocal_lock.cadence).toContain("deliberate");
    expect(compactManifest.character_asset_bible.vocal_lock.articulation).toContain("precise");
    expect(compactManifest.character_asset_bible.vocal_lock.immutable_across_sequence).toBe(true);
    expect(compactManifest.scene_blueprint.performance_manifest.natural_kinetics.gesture_cues[0].type)
      .toContain("open-hand");
    expect(compactManifest.scene_blueprint.performance_manifest.natural_kinetics.performance_mode)
      .toBe("single-gesture");
    expect(compactManifest.scene_blueprint.performance_manifest.natural_kinetics.gesture_policy)
      .toContain("exactly once");
    expect(compactManifest.scene_blueprint.performance_manifest.facial_constraints.biomechanics
      .lower_face_proportion_lock).toContain("must never shorten");
    expect(compactManifest.scene_blueprint.performance_manifest.facial_constraints.biomechanics
      .teeth_behavior).toContain("stable teeth and gum geometry");
    expect(compactManifest.scene_blueprint.performance_manifest.facial_constraints.biomechanics.jaw_behavior)
      .toBe(manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
        .performance_manifest.facial_constraints.facial_biomechanics.jaw_behavior);
    expect(compactManifest.scene_blueprint.performance_manifest.terminal_hold.min_seconds).toBe(0.75);
    expect(compactManifest.scene_blueprint.performance_manifest.terminal_hold.settle).toContain("one blink allowed");
    expect(compactManifest.scene_blueprint.performance_manifest.terminal_hold.boundary_lock_seconds).toBe(0.25);
    expect(compactManifest.scene_blueprint.performance_manifest.terminal_hold.boundary_lock_window).toEqual([29.75, 30]);
    expect(compactManifest.scene_blueprint.performance_manifest.terminal_hold.boundary_state).toContain("no new blink");
    expect(compactManifest.scene_blueprint.performance_manifest.terminal_hold.freeze_frames).toBe(3);
    expect(compactManifest.triple_lock_protocol.temporal).toContain("no early beat/reset");
    expect(compiled.videoPrompt.match(/We spent three weeks/g)).toHaveLength(1);
    expect(compiled.compactPromptReport.frameworkPreserved).toBe(true);
    expect(compiled.compactPromptReport.omittedExclusions).toEqual([]);
    expect(compiled.compactPromptReport.truncatedSections).toEqual([]);
  });

  it("projects an optional composition lock into both A-roll JSON surfaces", () => {
    const packet = JSON.parse(fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"));
    packet.shots[0].camera.compositionLock = {
      maxProjectedSubjectScaleChangePercent: 4,
      protectedFrameElements: ["full face", "both shoulders", "background practical"],
      forbidDigitalZoom: true,
    };

    const compiled = compilePacket(packet).shots[0]!;
    const manifest = JSON.parse(compiled.videoPrompt).project_manifest;
    const compactManifest = JSON.parse(compiled.compactVideoPrompt).project_manifest;
    const expectedLock = {
      max_projected_subject_scale_change_percent: 4,
      protected_frame_elements: ["full face", "both shoulders", "background practical"],
      forbid_digital_zoom: true,
    };

    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["2_cinematography_optics_and_psychology"]
      .composition_lock).toEqual(expectedLock);
    expect(compactManifest.scene_blueprint.cinematography_optics_psychology.composition_lock)
      .toEqual(expectedLock);
  });

  it("omits an absent composition lock from both A-roll JSON surfaces", () => {
    const packet = JSON.parse(fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"));
    delete packet.shots[0].camera.compositionLock;

    const compiled = compilePacket(packet).shots[0]!;
    const manifest = JSON.parse(compiled.videoPrompt).project_manifest;
    const compactManifest = JSON.parse(compiled.compactVideoPrompt).project_manifest;

    expect(manifest.layer_iv_scene_blueprint.keyframe_directives["2_cinematography_optics_and_psychology"])
      .not.toHaveProperty("composition_lock");
    expect(compactManifest.scene_blueprint.cinematography_optics_psychology)
      .not.toHaveProperty("composition_lock");
  });

  it("keeps the expanded A-roll voice and kinetics controls optional for v1 packets", () => {
    const legacy = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    delete legacy.shots[0].performance.gestureBounds;
    delete legacy.shots[0].performance.headMotion;
    delete legacy.shots[0].performance.bodyMotion;
    delete legacy.shots[0].performance.gestureCues;
    delete legacy.shots[0].performance.microExpressionCues;
    delete legacy.shots[0].performance.mode;
    for (const key of [
      "accent", "basePitchHz", "personaTone", "cadenceStyle", "articulation",
      "intonationNotes", "timbre", "micStyle", "roomTone", "emphasisCues",
    ]) delete legacy.shots[0].audioTrack[key];

    const parsed = UniversalPacketSchema.parse(legacy);
    expect(parsed.shots[0]?.performance.gestureBounds).toBeUndefined();
    expect(parsed.shots[0]?.audioTrack.basePitchHz).toBeUndefined();
    expect(() => compilePacket(parsed)).not.toThrow();
  });

  it("rejects ambiguous A-roll gesture alternatives before compilation", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].performance.gestureCues[0].type = "precision pinch or half-open palm";
    expect(() => compilePacket(packet)).toThrow(/one exact physical action/);

    packet.shots[0].performance.gestureCues[0].type = "precision pinch and half-open palm";
    expect(() => compilePacket(packet)).toThrow(/one exact physical action/);

    packet.shots[0].performance.gestureCues[0].type = "precision pinch; half-open palm";
    expect(() => compilePacket(packet)).toThrow(/one exact physical action/);
  });

  it("requires single-gesture mode to declare exactly one cue", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].performance.mode = "single-gesture";
    packet.shots[0].performance.gestureCues = [];
    expect(() => compilePacket(packet)).toThrow(/must declare exactly one hand gesture/);
    expect(() => compileShot(packet.shots[0])).toThrow(/must declare exactly one hand gesture/);
  });

  it("requires deterministic speech-window planning on every spoken A-roll compile path", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    delete packet.shots[0].audioTrack.spokenWindow;
    expect(() => compilePacket(packet)).toThrow(/planARollSpeechWindow/);
    expect(() => compileShot(packet.shots[0])).toThrow(/planARollSpeechWindow/);
    expect(() => compileFrameworkVideoPrompt(packet.shots[0])).toThrow(/planARollSpeechWindow/);
    expect(() => compileCompactVideoPromptWithReport(packet.shots[0])).toThrow(/planARollSpeechWindow/);
  });

  it("normalizes reversed pitch bounds consistently after schema validation", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].audioTrack.pitchRangeHz = { min: 180, max: 90 };
    const parsed = UniversalPacketSchema.parse(packet);
    const manifest = JSON.parse(compilePacket(parsed).shots[0]!.compactVideoPrompt).project_manifest;
    expect(manifest.character_asset_bible.vocal_lock.pitch_range_hz).toEqual({ min: 90, max: 180 });
  });

  it("rejects hand cues that cluster inside any rolling eight-second window", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].durationSeconds = 16;
    packet.shots[0].performance.gestureCues = [
      { timeSeconds: 1, type: "right palm presentation" },
      { timeSeconds: 7.9, type: "left fingertip desk contact" },
    ];
    expect(() => compilePacket(packet)).toThrow(/inside one eight-second window/);
  });

  it("prevents caller gesture bounds from weakening the compiled A-roll contract", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].performance.gestureBounds.ratePer8SecondsMax = 12;
    packet.shots[0].performance.gestureBounds.amplitudeDegreesMax = 30;
    const manifest = JSON.parse(compilePacket(packet).shots[0]!.compactVideoPrompt).project_manifest;
    const bounds = manifest.scene_blueprint.performance_manifest.natural_kinetics.gesture_bounds;
    expect(bounds.ratePer8SecondsMax).toBe(1);
    expect(bounds.amplitudeDegreesMax).toBe(7);
  });

  it("rejects a repeated hand-gesture loop across consecutive A-roll shots", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const secondShot = structuredClone(packet.shots[0]);
    secondShot.id = "shot-2";
    secondShot.title = "The next sentence";
    secondShot.dialogue = "The next sentence advances the argument without repeating the same performance.";
    secondShot.audioTrack.spokenText = secondShot.dialogue;
    packet.shots.push(secondShot);
    packet.scenes[0].shotIds.push(secondShot.id);
    expect(() => compilePacket(packet)).toThrow(/repeats the previous shot/);
  });

  it("defaults cue-free A-roll to restrained stillness without invented presenter gestures", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].performance.mode = "restrained-stillness";
    packet.shots[0].performance.gestureCues = [];
    const manifest = JSON.parse(compilePacket(packet).shots[0]!.compactVideoPrompt).project_manifest;
    const kinetics = manifest.scene_blueprint.performance_manifest.natural_kinetics;
    expect(kinetics.performance_mode).toBe("restrained-stillness");
    expect(kinetics.gesture_bounds.handsEnabled).toBe(false);
    expect(kinetics.gesture_policy).toContain("do not invent presenter gestures");
  });

  it("rejects impossible A-roll pitch and movement bounds", () => {
    const invalid = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    invalid.shots[0].audioTrack.basePitchHz = 900;
    invalid.shots[0].performance.gestureBounds.ratePer8SecondsMax = -1;
    expect(() => UniversalPacketSchema.parse(invalid)).toThrow();
  });

  it("rejects gesture cues outside the shot or inside the A-roll terminal boundary", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const outsideShot = structuredClone(packet.shots[0]!);
    outsideShot.performance.gestureCues = [{ timeSeconds: 30, type: "late gesture" }];
    expect(() => UniversalPacketSchema.parse({
      ...packet,
      shots: [outsideShot],
    })).toThrow(/gesture cue must occur before the shot ends/);

    const insideBoundary = structuredClone(packet.shots[0]!);
    insideBoundary.performance.gestureCues = [{ timeSeconds: 29.8, type: "late gesture" }];
    expect(() => compileShot(insideBoundary)).toThrow(/terminal boundary lock/);
  });

  it("hard-routes legacy A-roll packets and emits their exact dialogue once", () => {
    const legacy = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const exactLine = legacy.shots[0].audioTrack.spokenText;
    legacy.shots[0].frameworkId = "continuous-take";
    legacy.shots[0].intent = `The speaker proves the point by saying ${exactLine}`;

    const compiled = compilePacket(legacy).shots[0]!;
    expect(compiled.frameworkId).toBe("avatar-a-roll-json");
    expect(() => JSON.parse(compiled.videoPrompt)).not.toThrow();
    expect(() => JSON.parse(compiled.compactVideoPrompt)).not.toThrow();
    expect(compiled.videoPrompt.split(exactLine)).toHaveLength(2);
    expect(compiled.compactVideoPrompt.split(exactLine)).toHaveLength(2);
  });

  it("does not let one-word A-roll dialogue rewrite fixed safeguards", () => {
    const packet = structuredClone(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    packet.shots[0].dialogue = "No.";
    packet.shots[0].audioTrack.spokenText = "No.";
    packet.shots[0].intent = "The speaker answers No. without theatrical emphasis.";
    packet.shots[0].beats = [
      { startSeconds: 0, endSeconds: 4, action: "The speaker listens and breathes naturally." },
      { startSeconds: 4, endSeconds: 8, action: "The speaker answers No. and returns to neutral." },
    ];
    packet.shots[0].durationSeconds = 8;
    packet.shots[0].performance.mode = "restrained-stillness";
    packet.shots[0].performance.gestureCues = [];
    packet.metadata.targetDurationSeconds = 8;

    const compiled = compilePacket(packet).shots[0]!;
    expect(compiled.videoPrompt.split("No.")).toHaveLength(2);
    expect(compiled.compactVideoPrompt.split("No.")).toHaveLength(2);
    expect(compiled.videoPrompt).toContain("no paraphrase");
    expect(compiled.videoPrompt).toContain("no later action");
    expect(compiled.videoPrompt).toContain("no new action");
    expect(compiled.compactVideoPrompt).toContain("no rewrite");
    expect(compiled.compactVideoPrompt).toContain("no early beat");
  });

  it("blocks impossible A-roll speech windows and terminal holds", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const shot = structuredClone(packet.shots[0]!);
    shot.durationSeconds = 8;
    shot.performance.mode = "restrained-stillness";
    shot.performance.gestureCues = [];
    shot.dialogue = "Most AI videos fail before the model generates a frame because the idea never became a production plan.";
    shot.audioTrack.spokenText = shot.dialogue;
    shot.audioTrack.paceWpm = 138;
    shot.audioTrack.spokenWindow = { startSeconds: 0.4, endSeconds: 7.9 };
    shot.performance.freezePadFramesAtEnd = 8;
    shot.beats = [
      { startSeconds: 0, endSeconds: 0.4, action: "hold closed lips" },
      { startSeconds: 0.4, endSeconds: 7.9, action: "say the approved line" },
      { startSeconds: 7.9, endSeconds: 8, action: "hold the terminal frame" },
    ];

    const issues = preflightPacket({
      ...packet,
      metadata: { ...packet.metadata, targetDurationSeconds: 8 },
      scenes: [{ ...packet.scenes[0]!, shotIds: [shot.id] }],
      shots: [shot],
    }).issues;
    expect(issues.map((issue) => issue.code)).toContain("SPOKEN_WINDOW_PACE_CONFLICT");
    expect(issues.map((issue) => issue.code)).toContain("AROLL_TERMINAL_HOLD_CONFLICT");
    expect(issues.map((issue) => issue.code)).toContain("AROLL_DELAYED_SPEECH_RUNTIME_CHECK");
  });

  it("reserves a real A-roll post-phoneme settle window", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const shot = structuredClone(packet.shots[0]!);
    shot.durationSeconds = 8;
    shot.performance.gestureCues = [];
    shot.dialogue = "One production contract keeps face, voice, timing, and handoff coherent.";
    shot.audioTrack.spokenText = shot.dialogue;
    shot.audioTrack.paceWpm = 140;
    shot.audioTrack.spokenWindow = { startSeconds: 0, endSeconds: 7.25 };
    shot.performance.freezePadFramesAtEnd = 8;
    shot.beats = [
      { startSeconds: 0, endSeconds: 7.25, action: "say the approved line exactly once" },
      { startSeconds: 7.25, endSeconds: 8, action: "settle naturally into the closed-lip terminal state" },
    ];

    const safeIssues = preflightPacket({
      ...packet,
      metadata: { ...packet.metadata, targetDurationSeconds: 8 },
      scenes: [{ ...packet.scenes[0]!, shotIds: [shot.id] }],
      shots: [shot],
    }).issues;
    expect(safeIssues.map((issue) => issue.code)).not.toContain("AROLL_TERMINAL_HOLD_CONFLICT");

    shot.audioTrack.spokenWindow.endSeconds = 7.3;
    const unsafeIssues = preflightPacket({
      ...packet,
      metadata: { ...packet.metadata, targetDurationSeconds: 8 },
      scenes: [{ ...packet.scenes[0]!, shotIds: [shot.id] }],
      shots: [shot],
    }).issues;
    expect(unsafeIssues.map((issue) => issue.code)).toContain("AROLL_TERMINAL_HOLD_CONFLICT");
  });

  it("applies provider timing slack before accepting an A-roll speech window", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const shot = structuredClone(packet.shots[0]!);
    shot.durationSeconds = 8;
    shot.performance.gestureCues = [];
    shot.dialogue = "Most videos fail before generation because the idea never became a production plan.";
    shot.audioTrack.spokenText = shot.dialogue;
    shot.audioTrack.paceWpm = 120;
    shot.audioTrack.spokenWindow = { startSeconds: 1, endSeconds: 7.3 };
    shot.beats = [
      { startSeconds: 1, endSeconds: 7.3, action: "say the approved line exactly once" },
      { startSeconds: 7.3, endSeconds: 8, action: "settle naturally into the closed-lip terminal state" },
    ];

    const issues = preflightPacket({
      ...packet,
      metadata: { ...packet.metadata, targetDurationSeconds: 8 },
      scenes: [{ ...packet.scenes[0]!, shotIds: [shot.id] }],
      shots: [shot],
    }).issues;
    expect(issues.map((issue) => issue.code)).toContain("SPOKEN_WINDOW_PACE_CONFLICT");
    expect(issues.map((issue) => issue.code)).toContain("AROLL_TERMINAL_HOLD_CONFLICT");
  });

  it("rejects an A-roll window whose implied speech rate is slower than its voice lock", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const shot = structuredClone(packet.shots[0]!);
    shot.durationSeconds = 8;
    shot.performance.mode = "restrained-stillness";
    shot.performance.gestureCues = [];
    shot.dialogue = "Most videos fail because the idea never became a production plan.";
    shot.audioTrack.spokenText = shot.dialogue;
    shot.audioTrack.paceWpm = 145;
    shot.audioTrack.speechRateTolerancePercent = 8;
    shot.audioTrack.spokenWindow = { startSeconds: 0, endSeconds: 5.5 };
    const issues = preflightPacket({
      ...packet,
      metadata: { ...packet.metadata, targetDurationSeconds: 8 },
      scenes: [{ ...packet.scenes[0]!, shotIds: [shot.id] }],
      shots: [shot],
    }).issues;
    expect(issues.map((issue) => issue.code)).toContain("AROLL_SPEECH_RATE_DRIFT");
  });

  it("does not apply the A-roll timing guard to other frameworks", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const shot = structuredClone(packet.shots[0]!);
    shot.frameworkId = "continuous-take";
    shot.durationSeconds = 8;
    shot.performance.gestureCues = [];
    shot.dialogue = "Most videos fail before generation because the idea never became a production plan.";
    shot.audioTrack.spokenText = shot.dialogue;
    shot.audioTrack.paceWpm = 138;
    shot.audioTrack.spokenWindow = { startSeconds: 0, endSeconds: 6.1 };

    const issues = preflightPacket({
      ...packet,
      metadata: { ...packet.metadata, targetDurationSeconds: 8, format: "short-film" },
      scenes: [{ ...packet.scenes[0]!, shotIds: [shot.id] }],
      shots: [shot],
    }).issues;
    expect(issues.map((issue) => issue.code)).not.toContain("SPOKEN_WINDOW_PACE_CONFLICT");
  });

  it("clips A-roll timeline beats at the terminal-hold boundary", () => {
    const packet = UniversalPacketSchema.parse(JSON.parse(
      fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"),
    ));
    const shot = structuredClone(packet.shots[0]!);
    shot.durationSeconds = 8;
    shot.performance.mode = "restrained-stillness";
    shot.performance.gestureCues = [];
    shot.dialogue = "Hold the production line.";
    shot.audioTrack.spokenText = shot.dialogue;
    shot.audioTrack.paceWpm = 150;
    shot.audioTrack.spokenWindow = { startSeconds: 0, endSeconds: 6 };
    shot.beats = [{ startSeconds: 0, endSeconds: 8, action: "speak, gesture, then settle" }];

    const compiled = compileShot(shot);
    const compact = JSON.parse(compiled.compactVideoPrompt).project_manifest;
    const full = JSON.parse(compiled.videoPrompt).project_manifest;
    const compactTimeline = compact.scene_blueprint.performance_manifest.timeline;
    const fullTimeline = full.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.timeline;
    expect(compactTimeline).toEqual([{ seconds: [0, 6], action: "speak, gesture, then settle" }]);
    expect(fullTimeline).toEqual([{ time_range_seconds: [0, 6], action: "speak, gesture, then settle" }]);
    expect(compact.scene_blueprint.performance_manifest.terminal_hold.window).toEqual([6, 8]);
  });

  it("compiles brand control as a positive blank-surface state", () => {
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    shot.generationRisks = ["BRAND_OR_TEXT_CONTROL"];
    const compiled = compileShot(shot);

    expect(compiled.videoPrompt).toContain("Production design lock:");
    expect(compiled.videoPrompt).toContain("uninterrupted base material, color, finish, and geometry");
    expect(compiled.videoPrompt).not.toContain("No glyph, letter, number");
    expect(compiled.framePrompt).toContain("declared clean surfaces remain uninterrupted");
  });

  it("offers a deterministic compact handoff without losing production categories", () => {
    const shot = UniversalPacketSchema.parse(example).shots[0]!;
    const compact = compileCompactVideoPrompt(shot, example.globalExclusions);
    expect(compact).toBe(compileCompactVideoPrompt(shot, example.globalExclusions));
    expect(compact.split("\n")).toHaveLength(1);
  });

  it("prioritizes shot-specific safeguards over generic exclusions in compact prompts", () => {
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    shot.exclusions = [
      ...example.globalExclusions,
      "no widened eyes or mugging",
      "do not begin after the contact event",
      "no contact-free object motion",
      "no static payoff pose",
      "no added reaction beat",
      "no reverse motion",
      "no object duplication",
      "no skipped terminal state",
      "no unrelated camera mark",
    ];
    const compact = compileCompactVideoPrompt(shot, example.globalExclusions);
    expect(compact).toContain("no widened eyes or mugging");
    expect(compact).toContain("do not begin after the contact event");
    expect(compact).toContain("no added reaction beat");
    expect(compact).toContain("no unrelated camera mark");
  });

  it("derives depth-of-field character from optics", () => {
    expect(depthOfFieldCharacter({ focalLengthMm: 24, tStop: 8, subjectDistanceMeters: 5 })).toContain("deep focus");
    expect(depthOfFieldCharacter({ focalLengthMm: 85, tStop: 1.4, subjectDistanceMeters: 1.2 })).toContain("very shallow");
  });

  it("bounds compact prompts and reports every omitted safeguard", () => {
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    shot.exclusions = Array.from({ length: 100 }, (_, index) => (
      `no synthetic failure mode ${index + 1} with duplicated geometry and unrelated motion`
    ));
    const result = compileCompactVideoPromptWithReport(shot);
    expect(result.prompt.length).toBeLessThanOrEqual(result.toolkitBudget);
    expect(result.wasCompacted).toBe(true);
    expect(result.frameworkPreserved).toBe(result.truncatedSections.length === 0);
    expect(result.omittedExclusions.length).toBeGreaterThan(0);
    expect(result.prompt).toContain("no identity drift");
    expect(result.prompt).toContain("no geometry morphing");
    expect(result.characterCount).toBe(result.prompt.length);
  });

  it("reports global exclusions that do not fit the compact prompt budget", () => {
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    const globalExclusions = Array.from({ length: 40 }, (_, index) => (
      `no global failure mode ${index + 1} with unrelated geometry, text, or motion`
    ));
    const result = compileCompactVideoPromptWithReport(shot, globalExclusions, [], {
      maxCharacters: 1200,
    });
    expect(result.prompt.length).toBeLessThanOrEqual(1200);
    expect(result.omittedExclusions).toContain(globalExclusions.at(-1));
    expect(result.wasCompacted).toBe(true);
  });

  it("refuses a compact prompt that truncated away the approved spoken line", () => {
    // Compaction clips whole sections, and the audio section is clippable like any
    // other. Before the guard this returned success with the dialogue silently gone,
    // so the defect was only caught after the render. Fails on pre-fix source: the
    // 2000-character call returned a prompt containing the line zero times.
    const shot = structuredClone(UniversalPacketSchema.parse(example).shots[0]!);
    const line = "Of course there is another floor.";
    shot.dialogue = `Mara, under her breath: ${line}`;

    expect(() => compileCompactVideoPromptWithReport(shot, [], [], { maxCharacters: 2000 }))
      .toThrow(/lost the approved spoken line/);

    // Clean control: with room to fit, the same shot compiles and keeps the line once.
    const roomy = compileCompactVideoPromptWithReport(shot, [], [], { maxCharacters: 10000 });
    expect(roomy.prompt.split(line)).toHaveLength(2);
  });

  it("compiles a complete package with a passing preflight", () => {
    const twoShotExample = structuredClone(example);
    const secondShot = structuredClone(twoShotExample.shots[0]);
    secondShot.id = "shot-2";
    secondShot.title = "Second pour angle";
    twoShotExample.shots.push(secondShot);
    twoShotExample.scenes[0].shotIds.push(secondShot.id);
    twoShotExample.metadata.targetDurationSeconds = 16;

    const result = compilePacket(twoShotExample);
    expect(result.shots).toHaveLength(2);
    expect(result.preflight.passed).toBe(true);
    expect(result.shots[0]?.videoPrompt).toContain("16:9");
    for (const shot of result.shots) {
      for (const exclusion of twoShotExample.globalExclusions) {
        expect(shot.negativePrompt.split(exclusion)).toHaveLength(2);
        expect(shot.videoPrompt.split(exclusion)).toHaveLength(2);
      }
    }
  });

  it("preserves every required global style term in compiled prompts", () => {
    const result = compilePacket(example);
    for (const style of example.globalStyle) {
      expect(result.shots[0]?.videoPrompt).toContain(style);
      expect(result.shots[0]?.framePrompt).toContain(style);
    }
  });

  it("projects lived performance into every visual framework architecture", () => {
    const frameworkIds = [
      "cinematic-prose-stack",
      "act-shot-master-spec",
      "json-scene-contract",
      "temporal-evolution",
      "timed-social-sequence",
      "practical-stunt-contract",
      "continuous-take",
    ];
    for (const frameworkId of frameworkIds) {
      const packet = structuredClone(example);
      packet.shots[0].frameworkId = frameworkId;
      packet.shots[0].performance = {
        basePosture: "grounded at the table without a presentation pose",
        bodyMotion: {
          breathingPattern: "quiet breathing continues underneath the visible action",
        },
        livedBehavior: {
          perceptionBeforeAction: "eyes find the hinge before the hand commits",
          involuntaryContinuity: ["one irregular blink", "breathing never freezes"],
          asynchronousOverlap: "eyes, breath, fingers, and fabric respond at slightly different moments",
          recoveryAndSettle: "the hand releases asymmetrically and the shoulder settles after contact",
        },
      };
      const prompt = compilePacket(packet).shots[0]!.videoPrompt;
      expect(prompt, frameworkId).toContain("eyes find the hinge before the hand commits");
      expect(prompt, frameworkId).toContain("breathing never freezes");
      expect(prompt, frameworkId).toContain("respond at slightly different moments");
      expect(prompt, frameworkId).toContain("shoulder settles after contact");
    }
  });

  it("preserves lived performance inside the Avatar A-Roll JSON contract", () => {
    const packet = JSON.parse(fs.readFileSync(new URL("../examples/a-roll.json", import.meta.url), "utf8"));
    packet.shots[0].performance.livedBehavior = {
      perceptionBeforeAction: "eyes land before the thought becomes speech",
      involuntaryContinuity: ["breathing continues across the full answer"],
      asynchronousOverlap: "blink, breath, and expression resolve independently",
      recoveryAndSettle: "the face and shoulders settle after the final word",
    };
    const manifest = JSON.parse(compilePacket(packet).shots[0]!.videoPrompt).project_manifest;
    const kinetics = manifest.layer_iv_scene_blueprint.keyframe_directives["1_subjects_kinetics_and_phenomenology"]
      .performance_manifest.natural_kinetics;
    expect(kinetics.lived_behavior.perceptionBeforeAction).toContain("eyes land before");
    expect(kinetics.lived_behavior.involuntaryContinuity).toContain("breathing continues across the full answer");
  });
});

describe("storyboard and QC", () => {
  it("compiles storyboard frame prompts identically to the prompt package", () => {
    // Both surfaces are projections of one packet, so a frame prompt that differs
    // between them means the packet is no longer the single source. Pinned after
    // buildStoryboard was found calling compileShot with no globalStyle, which
    // dropped the "Style: ..." clause from every panel while the prompt package
    // kept it. Fails on pre-fix source: panels carried no globalStyle term.
    const board = buildStoryboard(example);
    const compiled = compilePacket(example);
    expect(board).toHaveLength(compiled.shots.length);
    for (const [index, panel] of board.entries()) {
      const shot = compiled.shots[index]!;
      expect(panel.openingFramePrompt).toBe(shot.openingFramePrompt);
      expect(panel.terminalFramePrompt).toBe(shot.terminalFramePrompt);
      expect(panel.framePrompt).toBe(shot.framePrompt);
    }
    for (const style of example.globalStyle) {
      expect(board[0]?.openingFramePrompt).toContain(style);
      expect(board[0]?.terminalFramePrompt).toContain(style);
    }
  });

  it("projects shots into useful storyboard panels", () => {
    const board = buildStoryboard(example);
    expect(board[0]).toMatchObject({ shotId: "shot-1", durationSeconds: 8 });
    expect(board[0]?.framePrompt).toContain("hand-blown clear tumbler");
  });

  it("fails a temporal duration mismatch", () => {
    const broken = structuredClone(example);
    broken.shots[0].beats[2].endSeconds = 7;
    const report = preflightPacket(UniversalPacketSchema.parse(broken));
    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === "DURATION_MISMATCH")).toBe(true);
  });

  it("accepts spokenText as a complete required audio contract", () => {
    const spokenOnly = structuredClone(example);
    spokenOnly.shots[0].dialogue = undefined;
    spokenOnly.shots[0].audioTrack = {
      spokenText: "The detail is the proof.",
      soundDesignDirectives: [],
    };
    const report = preflightPacket(UniversalPacketSchema.parse(spokenOnly));
    expect(report.issues.some((issue) => issue.code === "AUDIO_CONTRACT_MISSING")).toBe(false);
  });

  it("preflights exact dialogue timing windows without breaking legacy packets", () => {
    const timed = structuredClone(example);
    timed.shots[0].dialogue = "Hold the frame.";
    timed.shots[0].audioTrack.spokenText = "Hold the frame.";
    timed.shots[0].audioTrack.spokenWindow = { startSeconds: 6, endSeconds: 9 };
    timed.shots[0].generationRisks = ["EXACT_DIALOGUE_AUDIO"];
    const outOfRange = preflightPacket(UniversalPacketSchema.parse(timed));
    expect(outOfRange.issues.some((issue) => issue.code === "SPOKEN_WINDOW_OUT_OF_RANGE")).toBe(true);

    delete timed.shots[0].audioTrack.spokenWindow;
    const legacy = preflightPacket(UniversalPacketSchema.parse(timed));
    expect(legacy.issues.some((issue) => issue.code === "SPOKEN_WINDOW_UNKNOWN")).toBe(true);
    expect(legacy.issues.some((issue) => issue.severity === "error" && issue.code.startsWith("SPOKEN_WINDOW"))).toBe(false);
  });

  it("blocks duplicate shot identifiers", () => {
    const duplicate = structuredClone(example);
    duplicate.shots.push(structuredClone(duplicate.shots[0]));
    duplicate.scenes[0].shotIds.push("shot-1");
    duplicate.metadata.targetDurationSeconds = 16;
    const report = preflightPacket(UniversalPacketSchema.parse(duplicate));
    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === "DUPLICATE_SHOT_ID")).toBe(true);
  });

  it("builds a constrained repair prompt", () => {
    const prompt = buildRepairPrompt({
      failure: "OBJECT_CONSERVATION",
      observedSymptom: "The glass disappears after the pour begins.",
      preserve: ["camera move", "workshop light", "glass geometry"],
    });
    expect(prompt).toContain("persistent objects");
    expect(prompt).toContain("PRESERVE");
  });

  it("repairs camera-scale overshoot without redesigning the accepted shot", () => {
    const prompt = buildRepairPrompt({
      failure: "CAMERA_SCALE_OVERSHOOT",
      observedSymptom: "The facade expands by roughly one third and crops the protected environmental wide.",
      preserve: ["building geometry", "coastal weather", "gust choreography", "material palette"],
    });
    expect(prompt).toContain("projected subject scale ceiling");
    expect(prompt).toContain("protect named frame elements");
    expect(prompt).toContain("forbid digital zoom");
    expect(prompt).toContain("PRESERVE: building geometry");
  });

  it("repairs exaggerated performance without redesigning the shot", () => {
    const prompt = buildRepairPrompt({
      failure: "PERFORMANCE_EXAGGERATION",
      observedSymptom: "The actor widens their eyes instead of holding the deadpan beat.",
      preserve: ["actor identity", "elevator geometry", "board dimensions"],
    });
    expect(prompt).toContain("one observable micro-expression");
    expect(prompt).toContain("forbid mugging");
  });

  it("repairs lifeless synchronized performance through causal human behavior", () => {
    const prompt = buildRepairPrompt({
      failure: "LIFELESS_PERFORMANCE",
      observedSymptom: "The actor remains technically stable but breath, eyes, hands, and posture move as one animation block.",
      preserve: ["actor identity", "object geometry", "camera path", "lighting"],
    });
    expect(prompt).toContain("perception before action");
    expect(prompt).toContain("involuntary continuity");
    expect(prompt).toContain("asynchronous overlap");
    expect(prompt).toContain("recovery and settle");
  });
});
