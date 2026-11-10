"""Shared wire-model policy. Schemas are generated from these models."""

from pydantic import BaseModel, ConfigDict, field_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class StrictContract(Contract):
    model_config = ConfigDict(strict=True, hide_input_in_errors=True)

    @field_validator("version", mode="before", check_fields=False)
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int:
            raise ValueError("Contract version must be an integer")
        return value
