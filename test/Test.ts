import assert from "assert";
import { 
  TestHelpers,
  CLFactory_DefaultUnstakedFeeChangedEntity
} from "generated";
const { MockDb, CLFactory } = TestHelpers;

describe("CLFactory contract DefaultUnstakedFeeChanged event tests", () => {
  // Create mock db
  const mockDb = MockDb.createMockDb();

  // Creating mock for CLFactory contract DefaultUnstakedFeeChanged event
  const event = CLFactory.DefaultUnstakedFeeChanged.createMockEvent({/* It mocks event fields with default values. You can overwrite them if you need */});

  // Processing the event
  const mockDbUpdated = CLFactory.DefaultUnstakedFeeChanged.processEvent({
    event,
    mockDb,
  });

  it("CLFactory_DefaultUnstakedFeeChangedEntity is created correctly", () => {
    // Getting the actual entity from the mock database
    let actualCLFactoryDefaultUnstakedFeeChangedEntity = mockDbUpdated.entities.CLFactory_DefaultUnstakedFeeChanged.get(
      `${event.transactionHash}_${event.logIndex}`
    );

    // Creating the expected entity
    const expectedCLFactoryDefaultUnstakedFeeChangedEntity: CLFactory_DefaultUnstakedFeeChangedEntity = {
      id: `${event.transactionHash}_${event.logIndex}`,
      oldUnstakedFee: event.params.oldUnstakedFee,
      newUnstakedFee: event.params.newUnstakedFee,
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    assert.deepEqual(actualCLFactoryDefaultUnstakedFeeChangedEntity, expectedCLFactoryDefaultUnstakedFeeChangedEntity, "Actual CLFactoryDefaultUnstakedFeeChangedEntity should be the same as the expectedCLFactoryDefaultUnstakedFeeChangedEntity");
  });
});
