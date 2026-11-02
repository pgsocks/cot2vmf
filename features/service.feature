Feature: Continuous CoT translation through UDP
  Operators can supervise the service and edit its mappings while it receives.

  Scenario: Receive without an operational schema or mapping
    When the "monitor" service workflow is exercised
    Then all service assertions succeed

  Scenario: Import schemas and mappings into persistent configuration offline
    When the "configuration" service workflow is exercised
    Then all service assertions succeed

  Scenario: Preserve Docker entrypoint defaults and explicit arguments
    When the "entrypoint-arguments" service workflow is exercised
    Then all service assertions succeed

  @web
  Scenario: Start the Docker service with environment and CLI overrides
    When the "entrypoint" service workflow is exercised
    Then all service assertions succeed

  Scenario: Translate saved outputs and apply offline edits after restart
    When the "translation" service workflow is exercised
    Then all service assertions succeed

  Scenario: Reject a configuration that cannot fit in restorable saved state
    When the "persistence-size" service workflow is exercised
    Then all service assertions succeed

  @web
  Scenario: Retain the last valid configuration while editing
    When the "editing" service workflow is exercised
    Then all service assertions succeed

  @web
  Scenario: Recover a saved draft after active publication fails
    When the "publication" service workflow is exercised
    Then all service assertions succeed

  @web
  Scenario: Reject stale edits across offline configuration replacements
    When the "revisions" service workflow is exercised
    Then all service assertions succeed

  @web
  Scenario: Accept normalized HTTP authorities on published ports
    When the "authorities" service workflow is exercised
    Then all service assertions succeed

  Scenario: Translate using a large lookup within service deadlines
    When the "large-lookup" service workflow is exercised
    Then all service assertions succeed

  @web
  Scenario: Refine a selected subset using stimulated output feedback
    When the "feedback" service workflow is exercised
    Then all service assertions succeed
