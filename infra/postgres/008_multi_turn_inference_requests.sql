ALTER TABLE inference_capabilities
  DROP CONSTRAINT inference_capabilities_max_requests_check,
  DROP CONSTRAINT inference_capabilities_max_input_tokens_check,
  DROP CONSTRAINT inference_capabilities_max_output_tokens_check;

ALTER TABLE inference_capabilities
  ADD CONSTRAINT inference_capabilities_max_requests_check CHECK (max_requests BETWEEN 1 AND 16),
  ADD CONSTRAINT inference_capabilities_max_input_tokens_check CHECK (max_input_tokens BETWEEN 1 AND 1000000),
  ADD CONSTRAINT inference_capabilities_max_output_tokens_check CHECK (max_output_tokens BETWEEN 1 AND 131072);

ALTER TABLE inference_requests
  DROP CONSTRAINT inference_requests_capability_id_role_key,
  DROP CONSTRAINT inference_requests_input_tokens_check,
  DROP CONSTRAINT inference_requests_output_tokens_check;

ALTER TABLE inference_requests
  ADD CONSTRAINT inference_requests_capability_role_request_key UNIQUE (capability_id,role,request_hash),
  ADD CONSTRAINT inference_requests_input_tokens_check CHECK (input_tokens BETWEEN 0 AND 1000000),
  ADD CONSTRAINT inference_requests_output_tokens_check CHECK (output_tokens BETWEEN 0 AND 131072);

